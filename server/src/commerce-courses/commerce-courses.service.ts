import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { computeCompleteness } from './completeness';
import { detailToCompletenessInput } from './version-snapshot';
import { HISTORY_ACTIONS, PublishingService } from './publishing.service';

/** 课程列表/详情/工作流（v2）。 */
@Injectable()
export class CommerceCoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly publishing: PublishingService,
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
    const where: Prisma.CommerceCourseWhereInput = { archivedAt: null };
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
          _count: { select: { lessons: { where: { archivedAt: null } } } },
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
    const [grouped, draft, published, online, hidden, offline] =
      await Promise.all([
        this.prisma.commerceCourse.groupBy({
          by: ['lifecycleStatus'],
          where: { archivedAt: null },
          _count: { _all: true },
        }),
        this.prisma.commerceCourse.count({
          where: { archivedAt: null, hasDraft: true },
        }),
        this.prisma.commerceCourse.count({
          where: { archivedAt: null, liveVersionId: { not: null } },
        }),
        this.prisma.commerceCourse.count({
          where: { archivedAt: null, liveStatus: 'ONLINE' },
        }),
        this.prisma.commerceCourse.count({
          where: { archivedAt: null, liveStatus: 'HIDDEN' },
        }),
        this.prisma.commerceCourse.count({
          where: { archivedAt: null, liveStatus: 'OFFLINE' },
        }),
      ]);
    const counts = {
      total: 0,
      draft,
      published,
      online,
      hidden,
      offline,
      notPublished: 0,
    };
    for (const g of grouped) counts.total += g._count._all;
    counts.notPublished = counts.total - counts.published;
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
        plans: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
        lessons: {
          where: { archivedAt: null },
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
    return {
      ...course,
      completeness: computeCompleteness(detailToCompletenessInput(course)),
    };
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

  // ===== 编辑工作区（草稿） =====
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
          hasDraft: true,
          lifecycleStatus: 'WORKING',
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
      await this.publishing.recordHistory(
        course.id,
        HISTORY_ACTIONS.CREATE_COURSE,
        { code },
        actorEmployeeId,
      );
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
    const current = await this.prisma.commerceCourse.findUnique({
      where: { id },
      select: { code: true, learningMode: true, learningLanguages: true },
    });
    if (!current)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    // Course ID 与 Learning mode 创建后不可修改（PRD §22）
    if (
      body.code !== undefined &&
      body.code.trim() &&
      body.code.trim().toUpperCase() !== current.code
    ) {
      throw new ConflictException({
        code: 'COURSE_ID_IMMUTABLE',
        message: 'Course ID cannot be changed.',
      });
    }
    if (
      body.learningMode !== undefined &&
      this.normaliseMode(body.learningMode) !== current.learningMode
    ) {
      throw new ConflictException({
        code: 'LEARNING_MODE_LOCKED',
        message: 'Learning mode cannot be changed after the course is created.',
      });
    }
    // 学习语言只能追加（PRD §22）
    const existingLanguages = (current.learningLanguages as string[]) ?? [];
    const requestedLanguages = body.learningLanguages;
    if (
      requestedLanguages &&
      existingLanguages.some(
        (language) => !requestedLanguages.includes(language),
      )
    ) {
      throw new ConflictException({
        code: 'LEARNING_LANGUAGE_REMOVE_FORBIDDEN',
        message: 'Learning languages can only be added, not removed.',
      });
    }
    if (
      requestedLanguages &&
      requestedLanguages.length < existingLanguages.length
    ) {
      throw new ConflictException({
        code: 'LEARNING_LANGUAGE_REMOVE_FORBIDDEN',
        message: 'Learning languages can only be added, not removed.',
      });
    }
    try {
      await this.prisma.commerceCourse.update({
        where: { id },
        data: {
          ...(body.slug !== undefined ? { slug: body.slug.trim() } : {}),
          ...(body.defaultContentLanguage !== undefined
            ? { defaultContentLanguage: body.defaultContentLanguage }
            : {}),
          ...(requestedLanguages !== undefined
            ? { learningLanguages: requestedLanguages }
            : {}),
          ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
          ...(body.level !== undefined ? { level: body.level } : {}),
          hasDraft: true,
          lifecycleStatus: 'WORKING',
          draftSourceType: null,
          draftSourceEnvironment: null,
          draftSourceVersionLabel: null,
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
    await this.prisma.$transaction([
      this.prisma.courseLocalization.upsert({
        where: { courseId_language: { courseId: id, language } },
        create: { courseId: id, language, ...data },
        update: data,
      }),
      this.prisma.commerceCourse.update({
        where: { id },
        data: { hasDraft: true, lifecycleStatus: 'WORKING' },
      }),
    ]);
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
    try {
      // 锁住课程行再取下一个序号：同时新建两节课不会拿到同一个 sortOrder / 默认 code
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CommerceCourse" WHERE id = ${id} FOR UPDATE`;
        const last = await tx.lesson.findFirst({
          where: { courseId: id },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const sortOrder = (last?.sortOrder ?? 0) + 1;
        const code = body.code?.trim() || `L${sortOrder}`;
        await tx.lesson.create({
          data: {
            courseId: id,
            code,
            sortOrder,
            localizations: {
              create: { language, title: body.title || code },
            },
          },
        });
      });
      await this.touchDraft(id);
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
      select: { id: true, courseId: true, archivedAt: true },
    });
    if (!lesson || lesson.courseId !== id || lesson.archivedAt) {
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
    // 课时字段与本地化一起写：任何一步失败都不留下半截修改；改成重复的 code 返回 409 而不是 500
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.lesson.update({
          where: { id: lessonId },
          data: {
            ...(body.code !== undefined ? { code: body.code.trim() } : {}),
            ...(body.sortOrder !== undefined
              ? { sortOrder: body.sortOrder }
              : {}),
          },
        });
        if (
          body.title !== undefined ||
          body.description !== undefined ||
          body.textHtml !== undefined
        ) {
          const existing = await tx.lessonLocalization.findUnique({
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
          await tx.lessonLocalization.upsert({
            where: { lessonId_language: { lessonId, language } },
            create: { lessonId, language, ...payload },
            update: payload,
          });
        }
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
    await this.touchDraft(id);
    return this.detail(id);
  }

  async deleteLesson(id: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true, archivedAt: true },
    });
    if (!lesson || lesson.courseId !== id || lesson.archivedAt) {
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found',
      });
    }
    // 条件软删除：ID 不复用，Publish 后才从线上消失，学员历史保留（PRD §22）；
    // 重复点击时第二次删不到就按 404 返回
    const removed = await this.prisma.lesson.updateMany({
      where: { id: lessonId, courseId: id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (removed.count === 0) {
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found',
      });
    }
    await this.prisma.trialSetting.deleteMany({
      where: { courseId: id, lessonId },
    });
    await this.touchDraft(id);
    return this.detail(id);
  }

  async reorderLessons(id: string, lessonIds: string[]) {
    await this.assertExists(id);
    if (
      !Array.isArray(lessonIds) ||
      lessonIds.some((lessonId) => typeof lessonId !== 'string') ||
      new Set(lessonIds).size !== lessonIds.length
    ) {
      throw new BadRequestException({
        code: 'LESSON_ORDER_INVALID',
        message: 'lessonIds must be a list of distinct lesson ids',
      });
    }
    // 只动本课程的课时：别的课程的课时 id 或不存在的 id 整批拒绝（404），不留半截排序
    await this.prisma.$transaction(async (tx) => {
      for (const [index, lessonId] of lessonIds.entries()) {
        const moved = await tx.lesson.updateMany({
          where: { id: lessonId, courseId: id },
          data: { sortOrder: index + 1 },
        });
        if (moved.count === 0) {
          throw new NotFoundException({
            code: 'LESSON_NOT_FOUND',
            message: 'Lesson not found',
          });
        }
      }
    });
    await this.touchDraft(id);
    return this.detail(id);
  }

  /** 任何内容编辑都只改草稿，并清空导入/恢复来源。 */
  private async touchDraft(id: string): Promise<void> {
    await this.prisma.commerceCourse.update({
      where: { id },
      data: {
        hasDraft: true,
        lifecycleStatus: 'WORKING',
        draftSourceType: null,
        draftSourceEnvironment: null,
        draftSourceVersionLabel: null,
      },
    });
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
    hasDraft: boolean;
    trialEnabled: boolean;
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
      liveVersionId: row.liveVersionId,
      hasDraft: row.hasDraft,
      trialEnabled: row.trialEnabled,
      published: Boolean(row.liveVersionId),
      updatedAt: row.updatedAt,
    };
  }
}
