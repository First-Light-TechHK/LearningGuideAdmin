import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';

/** 课程列表/详情/工作流（v2）。 */
@Injectable()
export class CommerceCoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
  ) {}

  /** 读取课程封面字节（Admin 预览用）。 */
  async getCoverBytes(
    id: string,
  ): Promise<{ bytes: Buffer; extension: string } | null> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
      select: { cover: { select: { storageKey: true, extension: true } } },
    });
    if (!course?.cover) return null;
    const bytes = await this.storage.getMedia(course.cover.storageKey);
    return { bytes, extension: course.cover.extension };
  }

  /** 读取课程某媒体资产字节（Admin 预览用，仅限该课程内资产）。 */
  async getMediaBytes(
    id: string,
    assetId: string,
  ): Promise<{ bytes: Buffer; extension: string } | null> {
    const asset = await this.prisma.courseMediaAsset.findUnique({
      where: { id: assetId },
      select: { courseId: true, storageKey: true, extension: true },
    });
    if (!asset || asset.courseId !== id) return null;
    const bytes = await this.storage.getMedia(asset.storageKey);
    return { bytes, extension: asset.extension };
  }

  async list(query: {
    search?: string;
    lifecycleStatus?: string;
    liveStatus?: string;
    categoryId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
    const where: Prisma.CommerceCourseWhereInput = {};
    if (query.lifecycleStatus)
      where.lifecycleStatus = query.lifecycleStatus as never;
    if (query.liveStatus) where.liveStatus = query.liveStatus as never;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        {
          localizations: {
            some: { title: { contains: q, mode: 'insensitive' } },
          },
        },
      ];
    }
    const [rows, total, counts] = await Promise.all([
      this.prisma.commerceCourse.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          category: true,
          localizations: true,
          cover: true,
          _count: { select: { lessons: true } },
        },
      }),
      this.prisma.commerceCourse.count({ where }),
      this.countsByStatus(),
    ]);
    return {
      courses: rows.map((row) => this.toSummary(row)),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      counts,
    };
  }

  private async countsByStatus() {
    const grouped = await this.prisma.commerceCourse.groupBy({
      by: ['lifecycleStatus'],
      _count: { _all: true },
    });
    const counts = { total: 0, working: 0, inUat: 0, approved: 0, live: 0 };
    for (const g of grouped) {
      const n = g._count._all;
      counts.total += n;
      if (g.lifecycleStatus === 'WORKING') counts.working = n;
      if (g.lifecycleStatus === 'IN_UAT') counts.inUat = n;
      if (g.lifecycleStatus === 'APPROVED') counts.approved = n;
      if (g.lifecycleStatus === 'LIVE') counts.live = n;
    }
    return counts;
  }

  async detail(id: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        lessons: {
          orderBy: { sortOrder: 'asc' },
          include: {
            localizations: { include: { video: true } },
            exhibits: { include: { media: true, thumbnail: true } },
            readings: { orderBy: { sortOrder: 'asc' } },
            questions: { orderBy: { sortOrder: 'asc' } },
            applicationTest: true,
            learningPoints: { orderBy: { sortOrder: 'asc' } },
            triggers: true,
          },
        },
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  async assertExists(id: string) {
    const found = await this.prisma.commerceCourse.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
  }

  async changeStatus(
    id: string,
    body: { status: 'ONLINE' | 'HIDDEN' | 'OFFLINE'; reason?: string },
  ) {
    await this.assertExists(id);
    await this.prisma.commerceCourse.update({
      where: { id },
      data: {
        liveStatus: body.status,
        ...(body.status === 'OFFLINE' ? { lifecycleStatus: 'WORKING' } : {}),
      },
    });
    return this.detail(id);
  }

  // ===== 工作流 =====
  async publishUat(id: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (course.archivedAt)
      throw new ConflictException({
        code: 'COURSE_ARCHIVED',
        message: 'Archived course cannot be published',
      });
    await this.prisma.commerceCourse.update({
      where: { id },
      data: {
        lifecycleStatus: 'IN_UAT',
        lastUatPublishedAt: new Date(),
        approvedAt: null,
        approvedBy: null,
      },
    });
    return this.detail(id);
  }

  async approve(id: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (course.lifecycleStatus !== 'IN_UAT') {
      throw new ConflictException({
        code: 'COURSE_INVALID_TRANSITION',
        message: 'Course must be in UAT before approval',
      });
    }
    await this.prisma.commerceCourse.update({
      where: { id },
      data: { lifecycleStatus: 'APPROVED', approvedAt: new Date() },
    });
    return this.detail(id);
  }

  async goLive(id: string, actorEmployeeId: string | null) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (course.lifecycleStatus !== 'APPROVED') {
      throw new ConflictException({
        code: 'COURSE_INVALID_TRANSITION',
        message: 'Course must be approved before going live',
      });
    }
    const snapshot = await this.buildSnapshotData(id);
    const last = await this.prisma.courseVersion.findFirst({
      where: { courseId: id },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    });
    const version = await this.prisma.courseVersion.create({
      data: {
        courseId: id,
        versionNo: (last?.versionNo ?? 0) + 1,
        snapshotData: snapshot,
        wentLiveAt: new Date(),
        createdBy: actorEmployeeId ?? null,
      },
    });
    await this.prisma.commerceCourse.update({
      where: { id },
      data: {
        lifecycleStatus: 'LIVE',
        liveStatus: 'ONLINE',
        liveVersionId: version.id,
      },
    });
    return this.detail(id);
  }

  async restore(id: string, versionId: string) {
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.courseId !== id) {
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Version not found',
      });
    }
    // 简化：仅返回快照供后续编辑器导入；实际重写工作副本在 P1b 编辑器实现时接入。
    return { restoredFrom: version.versionNo, snapshot: version.snapshotData };
  }

  async listVersions(id: string) {
    return this.prisma.courseVersion.findMany({
      where: { courseId: id },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        wentLiveAt: true,
        sourceVersionId: true,
        createdAt: true,
      },
    });
  }

  // ===== 编辑工作区（第一版） =====
  private static readonly LEARNING_MODES = [
    'VIDEO_ONLY',
    'TEXT_ONLY',
    'VIDEO_AND_TEXT',
  ];

  private normaliseMode(
    mode?: string,
  ): 'VIDEO_ONLY' | 'TEXT_ONLY' | 'VIDEO_AND_TEXT' {
    const m = (mode ?? '').toUpperCase();
    return (
      CommerceCoursesService.LEARNING_MODES.includes(m) ? m : 'VIDEO_AND_TEXT'
    ) as 'VIDEO_ONLY' | 'TEXT_ONLY' | 'VIDEO_AND_TEXT';
  }

  private slugify(input: string): string {
    const base = input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || 'course';
  }

  async createCourse(
    body: {
      code: string;
      slug?: string;
      title: string;
      language?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      categoryId?: string | null;
    },
    actorEmployeeId: string | null,
  ) {
    const language = body.defaultContentLanguage || body.language || 'en-GB';
    const learningLanguages =
      body.learningLanguages && body.learningLanguages.length > 0
        ? body.learningLanguages
        : [language];
    const code = (body.code?.trim() || this.slugify(body.title)).toUpperCase();
    const slug = body.slug?.trim() || this.slugify(body.title);
    try {
      const course = await this.prisma.commerceCourse.create({
        data: {
          code,
          slug,
          learningMode: this.normaliseMode(body.learningMode),
          defaultContentLanguage: language,
          learningLanguages: learningLanguages,
          categoryId: body.categoryId || null,
          subtitle: body.subtitle ?? null,
          localizations: {
            create: {
              language,
              title: body.title,
              shortDescription: body.subtitle ?? null,
            },
          },
          authors: actorEmployeeId
            ? { create: { employeeId: actorEmployeeId } }
            : undefined,
        },
        select: { id: true },
      });
      return this.detail(course.id);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'COURSE_CODE_DUPLICATE',
          message: 'A course with this code or slug already exists.',
        });
      }
      throw error;
    }
  }

  async updateCourse(
    id: string,
    body: {
      code?: string;
      slug?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      level?: string | null;
    },
  ) {
    await this.assertExists(id);
    try {
      await this.prisma.commerceCourse.update({
        where: { id },
        data: {
          ...(body.code !== undefined ? { code: body.code.trim() } : {}),
          ...(body.slug !== undefined ? { slug: body.slug.trim() } : {}),
          ...(body.learningMode !== undefined
            ? { learningMode: this.normaliseMode(body.learningMode) }
            : {}),
          ...(body.defaultContentLanguage !== undefined
            ? { defaultContentLanguage: body.defaultContentLanguage }
            : {}),
          ...(body.learningLanguages !== undefined
            ? {
                learningLanguages: body.learningLanguages,
              }
            : {}),
          ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
          ...(body.level !== undefined ? { level: body.level } : {}),
        },
      });
      return this.detail(id);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'COURSE_CODE_DUPLICATE',
          message: 'A course with this code or slug already exists.',
        });
      }
      throw error;
    }
  }

  async updateLocalization(
    id: string,
    language: string,
    body: {
      title: string;
      shortDescription?: string | null;
      overview?: string | null;
      whatYouLearn?: unknown;
      provides?: unknown;
    },
  ) {
    await this.assertExists(id);
    const data = {
      title: body.title,
      shortDescription: body.shortDescription ?? null,
      overview: body.overview ?? null,
      whatYouLearn: (body.whatYouLearn ?? null) as Prisma.InputJsonValue,
      provides: (body.provides ?? null) as Prisma.InputJsonValue,
    };
    await this.prisma.courseLocalization.upsert({
      where: { courseId_language: { courseId: id, language } },
      create: { courseId: id, language, ...data },
      update: data,
    });
    return this.detail(id);
  }

  async createLesson(
    id: string,
    body: { code?: string; language?: string; title: string },
  ) {
    await this.assertExists(id);
    const language =
      body.language ||
      (
        await this.prisma.commerceCourse.findUnique({
          where: { id },
          select: { defaultContentLanguage: true },
        })
      )?.defaultContentLanguage ||
      'en-GB';
    const last = await this.prisma.lesson.findFirst({
      where: { courseId: id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 1;
    const code = body.code?.trim() || `L${sortOrder}`;
    try {
      await this.prisma.lesson.create({
        data: {
          courseId: id,
          code,
          sortOrder,
          localizations: {
            create: { language, title: body.title || code },
          },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'LESSON_CODE_DUPLICATE',
          message: 'A lesson with this code already exists in the course.',
        });
      }
      throw error;
    }
    return this.detail(id);
  }

  async updateLesson(
    id: string,
    lessonId: string,
    body: {
      code?: string;
      sortOrder?: number;
      language?: string;
      title?: string;
      description?: string | null;
      textHtml?: string | null;
    },
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true },
    });
    if (!lesson || lesson.courseId !== id) {
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found',
      });
    }
    const language =
      body.language ||
      (
        await this.prisma.commerceCourse.findUnique({
          where: { id },
          select: { defaultContentLanguage: true },
        })
      )?.defaultContentLanguage ||
      'en-GB';
    await this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim() } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
    });
    if (
      body.title !== undefined ||
      body.description !== undefined ||
      body.textHtml !== undefined
    ) {
      const existing = await this.prisma.lessonLocalization.findUnique({
        where: { lessonId_language: { lessonId, language } },
        select: { title: true, description: true, textHtml: true },
      });
      const payload = {
        title: body.title ?? existing?.title ?? 'Untitled',
        description:
          body.description !== undefined
            ? body.description
            : (existing?.description ?? null),
        textHtml:
          body.textHtml !== undefined
            ? body.textHtml
            : (existing?.textHtml ?? null),
      };
      await this.prisma.lessonLocalization.upsert({
        where: { lessonId_language: { lessonId, language } },
        create: { lessonId, language, ...payload },
        update: payload,
      });
    }
    return this.detail(id);
  }

  async deleteLesson(id: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true },
    });
    if (!lesson || lesson.courseId !== id) {
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found',
      });
    }
    await this.prisma.lesson.delete({ where: { id: lessonId } });
    return this.detail(id);
  }

  async reorderLessons(id: string, lessonIds: string[]) {
    await this.assertExists(id);
    await this.prisma.$transaction(
      lessonIds.map((lessonId, index) =>
        this.prisma.lesson.update({
          where: { id: lessonId },
          data: { sortOrder: index + 1 },
        }),
      ),
    );
    return this.detail(id);
  }

  private async buildSnapshotData(id: string) {
    const detail = await this.detail(id);
    return {
      course: {
        id: detail.id,
        code: detail.code,
        slug: detail.slug,
        learningMode: detail.learningMode,
        defaultContentLanguage: detail.defaultContentLanguage,
        learningLanguages: detail.learningLanguages,
        localizations: detail.localizations,
        lessons: detail.lessons.map((lesson) => ({
          code: lesson.code,
          order: lesson.sortOrder,
          localizations: lesson.localizations,
          exhibits: lesson.exhibits.map((ex) => ({
            code: ex.code,
            type: ex.type,
            localized: ex.localized,
          })),
          readings: lesson.readings,
          questions: lesson.questions,
          applicationTest: lesson.applicationTest,
          learningPoints: lesson.learningPoints,
          triggers: lesson.triggers,
        })),
        trialRows: detail.trialRows,
      },
      versionedAt: new Date().toISOString(),
    };
  }

  private toSummary(row: {
    id: string;
    code: string;
    slug: string;
    learningMode: string;
    learningLanguages: unknown;
    lifecycleStatus: string;
    liveStatus: string;
    liveVersionId: string | null;
    updatedAt: Date;
    category: { id: string; name: string } | null;
    localizations: {
      language: string;
      title: string;
      shortDescription: string | null;
    }[];
    _count: { lessons: number };
  }) {
    const defaultLoc = row.localizations[0];
    return {
      id: row.id,
      code: row.code,
      slug: row.slug,
      title: defaultLoc?.title ?? row.slug,
      subtitle: defaultLoc?.shortDescription ?? null,
      category: row.category
        ? { id: row.category.id, name: row.category.name }
        : null,
      learningMode: row.learningMode,
      learningLanguages: row.learningLanguages,
      lessonCount: row._count.lessons,
      lifecycleStatus: row.lifecycleStatus,
      liveStatus: row.liveStatus,
      liveVersionNo: undefined,
      updatedAt: row.updatedAt,
    };
  }
}
