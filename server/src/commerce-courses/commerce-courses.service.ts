import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { pickSummaryLocalization, summaryTitle } from './course-summary';
import { HISTORY_ACTIONS, PublishingService } from './publishing.service';
import { syncTextPointsInTx } from './text-points';
import { runCourseWrite, type CourseTx } from './course-write';
import {
  assertCategoryBinding,
  COURSE_LANGUAGES,
  DEFAULT_LANGUAGE,
  DEFAULT_LEARNING_MODE,
  localizationData,
  nullableText,
  parseInformation,
  parseLanguage,
  parseLearningLanguages,
  parseLearningMode,
  parseLocalizationPatch,
  parseOptionalLanguage,
  parseTitles,
  type CourseLanguage,
  type LearningMode,
  type LocalizationPatch,
} from './course-info';
import { categoryRef } from './localized-fields';
import {
  allocate,
  allocateCourseCode,
  formatLessonCode,
  lessonCounterKey,
  peekCourseCode,
} from './code-allocator';
import { optionalString } from './input';
import { withDefaultLanguageTests } from './lesson-tests';

/** 新建请求体：新写法带 `titles`；旧写法 `title` + `language` 照常接受。 */
export interface CourseCreateBody {
  /** 已忽略：Course ID 由服务器分配（PRD L255），响应里是真实的编号。 */
  code?: string;
  /** 已忽略：slug 由服务器按课程名生成。 */
  slug?: string;
  title?: string;
  language?: string;
  titles?: Record<string, string>;
  learningMode?: string;
  defaultContentLanguage?: string;
  learningLanguages?: string[];
  subtitle?: string | null;
  categoryId?: string | null;
}

export interface CourseUpdateBody {
  code?: string;
  slug?: string;
  learningMode?: string;
  defaultContentLanguage?: string;
  learningLanguages?: string[];
  subtitle?: string | null;
  level?: string | null;
  categoryId?: string | null;
}

/** 新建课时请求体：新写法带 `titles`；旧写法 `title` + `language` 照常接受。 */
export interface LessonCreateBody {
  /** 已忽略：Lesson ID 由服务器分配。 */
  code?: string;
  language?: string;
  title?: string;
  titles?: Record<string, string>;
}

export interface LessonUpdateBody {
  /** 只能和现有的一致；不同就 400 LESSON_ID_IMMUTABLE。 */
  code?: string;
  /** 已忽略：改位置用 reorder。 */
  sortOrder?: number;
  language?: string;
  title?: string;
  description?: string | null;
  textHtml?: string | null;
}

/** 校验、整理过的更新字段。 */
interface CourseUpdatePatch {
  code?: string;
  slug?: string;
  learningMode?: LearningMode;
  defaultContentLanguage?: CourseLanguage;
  learningLanguages?: CourseLanguage[];
  subtitle?: string | null;
  level?: string | null;
  categoryId?: string | null;
}

/** 课程列表/详情/工作流（v2）�?*/
@Injectable()
export class CommerceCoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly publishing: PublishingService,
  ) {}

  /** 读取课程封面的存储位置（Admin 预览用）。 */
  async getCoverBytes(id: string): Promise<{
    storageKey: string;
    extension: string;
    size: number | null;
  } | null> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id },
      select: {
        cover: { select: { storageKey: true, extension: true, size: true } },
      },
    });
    if (!course?.cover) return null;
    return {
      storageKey: course.cover.storageKey,
      extension: course.cover.extension,
      size: course.cover.size,
    };
  }

  /** 读取课程某媒体资产的存储位置（Admin 预览用，仅限该课程内资产）。 */
  async getMediaBytes(
    id: string,
    assetId: string,
  ): Promise<{
    storageKey: string;
    extension: string;
    size: number | null;
  } | null> {
    const asset = await this.prisma.courseMediaAsset.findUnique({
      where: { id: assetId },
      select: { courseId: true, storageKey: true, extension: true, size: true },
    });
    if (!asset || asset.courseId !== id) return null;
    return {
      storageKey: asset.storageKey,
      extension: asset.extension,
      size: asset.size,
    };
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
    const liveVersionIds = rows
      .map((row) => row.liveVersionId)
      .filter((id): id is string => Boolean(id));
    const liveVersions = liveVersionIds.length
      ? await this.prisma.courseVersion.findMany({
          where: { id: { in: liveVersionIds } },
          select: {
            id: true,
            versionLabel: true,
            wentLiveAt: true,
            createdAt: true,
          },
        })
      : [];
    const liveVersionById = new Map(
      liveVersions.map((version) => [version.id, version]),
    );
    return {
      courses: rows.map((row) => {
        const liveVersion = row.liveVersionId
          ? liveVersionById.get(row.liveVersionId)
          : undefined;
        return {
          ...this.toSummary(row),
          liveVersionLabel: liveVersion?.versionLabel ?? null,
          liveVersionWentLiveAt:
            liveVersion?.wentLiveAt?.toISOString() ??
            liveVersion?.createdAt.toISOString() ??
            null,
        };
      }),
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
            exhibits: {
              include: { media: true, thumbnail: true },
              orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            },
            readings: { orderBy: { sortOrder: 'asc' } },
            questions: { orderBy: { sortOrder: 'asc' } },
            applicationTests: true,
            learningPoints: { orderBy: { sortOrder: 'asc' } },
            // 先按时间再按保存顺序；没填时间的排在最后。
            triggers: {
              orderBy: [{ timeSeconds: 'asc' }, { sortOrder: 'asc' }],
            },
          },
        },
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    // 测试按语言保存；在 B14 之前页面仍只认默认内容语言的那一份（lesson.applicationTest）。
    const shaped = withDefaultLanguageTests(course);
    // 完成度和 Publish 门禁用同一条路径（先拍快照再算），详情里看到的就是发布时会判的。
    const completeness = await this.publishing.completenessForDraft(course.id);
    return {
      ...shaped,
      category: categoryRef(course.category),
      completeness,
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

  // ===== 编辑工作区（草稿�?=====
  /** 标题的拉丁字母部分；没有拉丁字母时为空，由调用方改用 Course ID。 */
  private slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** 在事务里挑一个没被占用的 slug：标题的 slug，没有拉丁字母就用 Course ID，重名加 -2、-3。 */
  private async freeSlug(
    tx: Prisma.TransactionClient,
    wanted: string,
    code: string,
  ): Promise<string> {
    const base = wanted || code.toLowerCase();
    for (let n = 1; ; n += 1) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken = await tx.commerceCourse.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!taken) return slug;
    }
  }

  /**
   * 新建课程：一次请求、一个事务——分配 Course ID、建课程、建中英两份基本信息、写 History，
   * 任何一步失败都整个回滚，不留半个课程，也不烧掉编号。
   *
   * 新请求体带 `titles`（每种语言的课程名）；旧请求体的 `title` + `language` 照旧能用，
   * 按默认内容语言归入 `titles`。`code` 和 `slug` 不再由调用方指定。
   */
  async createCourse(body: CourseCreateBody, actorEmployeeId: string | null) {
    const learningMode =
      parseLearningMode(body.learningMode) ?? DEFAULT_LEARNING_MODE;
    const language = parseLanguage(
      body.defaultContentLanguage || body.language || DEFAULT_LANGUAGE,
      'defaultContentLanguage',
    );
    const requested = parseLearningLanguages(body.learningLanguages);
    const learningLanguages = requested?.length ? requested : [language];
    if (!learningLanguages.includes(language)) {
      throw new BadRequestException({
        code: 'DEFAULT_LANGUAGE_NOT_LEARNING',
        message: 'The default content language must be a learning language.',
        details: { field: 'defaultContentLanguage' },
      });
    }
    const titles = parseTitles(body.titles);
    const legacyTitle = optionalString(body.title, 'title');
    if (titles[language] === undefined && legacyTitle !== undefined) {
      titles[language] = legacyTitle;
    }
    const subtitle = nullableText(body.subtitle, 'subtitle') ?? null;
    const requestedCategory = nullableText(body.categoryId, 'categoryId');
    const slugBase =
      [titles[language], titles['en-GB'], titles['zh-CN']]
        .map((title) => this.slugify(title ?? ''))
        .find(Boolean) ?? '';
    // 两个同时创建、标题又相同的请求可能挑中同一个 slug：唯一键拒绝后整个事务（含编号）回滚，重试一次。
    for (let attempt = 1; ; attempt += 1) {
      try {
        const course = await this.prisma.$transaction(async (tx) => {
          const categoryId = await assertCategoryBinding(tx, requestedCategory);
          const code = await allocateCourseCode(tx);
          const slug = await this.freeSlug(tx, slugBase, code);
          const created = await tx.commerceCourse.create({
            data: {
              code,
              slug,
              learningMode,
              defaultContentLanguage: language,
              learningLanguages,
              categoryId,
              subtitle,
              hasDraft: true,
              lifecycleStatus: 'WORKING',
              // 基本信息两种语言各一行；没填的课程名留空，完整性规则报 Required。
              localizations: {
                create: COURSE_LANGUAGES.map((courseLanguage) => ({
                  language: courseLanguage,
                  title: titles[courseLanguage] ?? '',
                  shortDescription:
                    courseLanguage === language ? subtitle : null,
                })),
              },
              authors: actorEmployeeId
                ? { create: { employeeId: actorEmployeeId } }
                : undefined,
            },
            select: { id: true },
          });
          await this.publishing.recordHistory(
            created.id,
            HISTORY_ACTIONS.CREATE_COURSE,
            { courseCode: code, learningMode, learningLanguages },
            actorEmployeeId,
            undefined,
            tx,
          );
          return { id: created.id };
        });
        return this.detail(course.id);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          if (attempt < 5) continue;
          throw new ConflictException({
            code: 'COURSE_CODE_DUPLICATE',
            message: 'A course with this code or slug already exists.',
          });
        }
        throw error;
      }
    }
  }

  /** 创建对话框显示的下一个 Course ID（只看不占；真正的编号在创建时取）。 */
  async nextCode(): Promise<{ code: string }> {
    return { code: await peekCourseCode(this.prisma) };
  }

  async updateCourse(
    id: string,
    body: CourseUpdateBody,
    actorEmployeeId: string | null = null,
  ) {
    const patch = this.parseCourseUpdate(body);
    try {
      await runCourseWrite(this.prisma, id, (tx) =>
        this.applyCourseUpdate(tx, id, patch, actorEmployeeId),
      );
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
    return this.detail(id);
  }

  /** 把请求体整理成已校验的字段；形状不对的在这里 400，不进事务。 */
  private parseCourseUpdate(body: CourseUpdateBody): CourseUpdatePatch {
    const code = optionalString(body.code, 'code');
    const slug = optionalString(body.slug, 'slug');
    if (slug !== undefined && !slug.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'slug cannot be empty.',
        details: { field: 'slug' },
      });
    }
    return {
      code,
      slug: slug?.trim(),
      learningMode: parseLearningMode(body.learningMode),
      defaultContentLanguage:
        body.defaultContentLanguage === undefined ||
        body.defaultContentLanguage === null
          ? undefined
          : parseLanguage(
              body.defaultContentLanguage,
              'defaultContentLanguage',
            ),
      learningLanguages: parseLearningLanguages(body.learningLanguages),
      subtitle: nullableText(body.subtitle, 'subtitle'),
      level: nullableText(body.level, 'level'),
      categoryId: nullableText(body.categoryId, 'categoryId'),
    };
  }

  private async applyCourseUpdate(
    tx: CourseTx,
    id: string,
    body: CourseUpdatePatch,
    actorEmployeeId: string | null,
  ) {
    const current = await tx.commerceCourse.findUnique({
      where: { id },
      select: {
        code: true,
        learningMode: true,
        learningLanguages: true,
        categoryId: true,
      },
    });
    if (!current)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    // Course ID �?Learning mode 创建后不可修改（PRD §22�?
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
      body.learningMode !== current.learningMode
    ) {
      throw new ConflictException({
        code: 'LEARNING_MODE_LOCKED',
        message: 'Learning mode cannot be changed after the course is created.',
      });
    }
    // 学习语言只能追加（PRD §22�?
    const existingLanguages = (current.learningLanguages as string[]) ?? [];
    const requestedLanguages: string[] | undefined = body.learningLanguages;
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
    const finalLanguages = requestedLanguages ?? existingLanguages;
    if (
      body.defaultContentLanguage !== undefined &&
      !finalLanguages.includes(body.defaultContentLanguage)
    ) {
      throw new BadRequestException({
        code: 'DEFAULT_LANGUAGE_NOT_LEARNING',
        message: 'The default content language must be a learning language.',
        details: { field: 'defaultContentLanguage' },
      });
    }
    const categoryId =
      body.categoryId === undefined
        ? undefined
        : await assertCategoryBinding(tx, body.categoryId);
    await tx.commerceCourse.update({
      where: { id },
      data: {
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.defaultContentLanguage !== undefined
          ? { defaultContentLanguage: body.defaultContentLanguage }
          : {}),
        ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
        ...(body.level !== undefined ? { level: body.level } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
    });
    if (requestedLanguages !== undefined) {
      await this.setLearningLanguages(
        tx,
        { id, code: current.code, learningLanguages: existingLanguages },
        requestedLanguages,
        actorEmployeeId,
      );
    }
  }

  /** 学习语言只增不减；多了语言就在同一个事务里写 ADD_LEARNING_LANGUAGE（PRD 历史记录）。 */
  private async setLearningLanguages(
    tx: CourseTx,
    course: { id: string; code: string; learningLanguages: string[] },
    requested: string[],
    actorEmployeeId: string | null,
  ) {
    const added = requested.filter(
      (language) => !course.learningLanguages.includes(language),
    );
    if (added.length === 0) return;
    await tx.commerceCourse.update({
      where: { id: course.id },
      data: { learningLanguages: requested },
    });
    await this.publishing.recordHistory(
      course.id,
      HISTORY_ACTIONS.ADD_LEARNING_LANGUAGE,
      {
        courseCode: course.code,
        from: course.learningLanguages,
        to: requested,
      },
      actorEmployeeId,
      undefined,
      tx,
    );
  }

  /** 只改这次发来的键；没发的键（课程名、概述、条目列表）保持原样。 */
  private async saveLocalization(
    tx: CourseTx,
    courseId: string,
    language: CourseLanguage,
    patch: LocalizationPatch,
  ) {
    const data = localizationData(patch);
    await tx.courseLocalization.upsert({
      where: { courseId_language: { courseId, language } },
      create: { courseId, language, title: '', ...data },
      update: data,
    });
  }

  async updateLocalization(id: string, language: string, body: unknown) {
    const courseLanguage = parseLanguage(language, 'language');
    const patch = parseLocalizationPatch(body);
    await runCourseWrite(this.prisma, id, (tx) =>
      this.saveLocalization(tx, id, courseLanguage, patch),
    );
    return this.detail(id);
  }

  /**
   * 第一步（Course Information）一次保存：分类、两种语言的基本信息、追加学习语言，
   * 一个事务，哪一部分被拒就都不写。返回课程详情，里面带着还缺什么（completeness.issues）。
   */
  async updateInformation(
    id: string,
    body: unknown,
    actorEmployeeId: string | null,
  ) {
    const input = parseInformation(body);
    await runCourseWrite(this.prisma, id, async (tx) => {
      const current = await tx.commerceCourse.findUniqueOrThrow({
        where: { id },
        select: { code: true, learningLanguages: true },
      });
      const existing = (current.learningLanguages as string[]) ?? [];
      const requested = [
        ...existing,
        ...input.addLearningLanguages.filter(
          (language) => !existing.includes(language),
        ),
      ];
      await this.setLearningLanguages(
        tx,
        { id, code: current.code, learningLanguages: existing },
        requested,
        actorEmployeeId,
      );
      if (input.categoryId !== undefined) {
        const categoryId = await assertCategoryBinding(tx, input.categoryId);
        await tx.commerceCourse.update({
          where: { id },
          data: { categoryId },
        });
      }
      for (const [language, patch] of input.localizations) {
        await this.saveLocalization(tx, id, language, patch);
      }
    });
    return this.detail(id);
  }

  /** 在已锁住课程的事务里取下一个 Lesson ID（L001、L002……）；跳过本课程里已经有的编号。 */
  private async allocateLessonCode(tx: CourseTx, courseId: string) {
    for (;;) {
      const code = formatLessonCode(
        await allocate(tx, lessonCounterKey(courseId)),
      );
      const taken = await tx.lesson.findUnique({
        where: { courseId_code: { courseId, code } },
        select: { id: true },
      });
      if (!taken) return code;
    }
  }

  /**
   * 新建课时：Lesson ID 由服务器分配（删除后不复用），位置排在启用课时的最后，
   * 两种语言的课时信息各一行。课时名没填就留空，完整性规则报 Required，不替用户编一个。
   * 旧请求体的 `title` + `language` 照常接受；`code` 不再由调用方指定。
   */
  async createLesson(id: string, body: LessonCreateBody) {
    const titles = parseTitles(body.titles);
    const legacyTitle = optionalString(body.title, 'title');
    const requestedLanguage = parseOptionalLanguage(body.language, 'language');
    try {
      // 课程行在事务里已锁住，取序号和建课时之间不会有第二个请求插进来
      await runCourseWrite(this.prisma, id, async (tx) => {
        const course = await tx.commerceCourse.findUniqueOrThrow({
          where: { id },
          select: { defaultContentLanguage: true },
        });
        const courseDefault = (COURSE_LANGUAGES as readonly string[]).includes(
          course.defaultContentLanguage,
        )
          ? (course.defaultContentLanguage as CourseLanguage)
          : DEFAULT_LANGUAGE;
        const language = requestedLanguage ?? courseDefault;
        if (titles[language] === undefined && legacyTitle !== undefined) {
          titles[language] = legacyTitle;
        }
        const last = await tx.lesson.findFirst({
          where: { courseId: id, archivedAt: null },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        await tx.lesson.create({
          data: {
            courseId: id,
            code: await this.allocateLessonCode(tx, id),
            sortOrder: (last?.sortOrder ?? 0) + 1,
            localizations: {
              create: COURSE_LANGUAGES.map((courseLanguage) => ({
                language: courseLanguage,
                title: titles[courseLanguage] ?? '',
              })),
            },
          },
        });
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

  /**
   * 改课时：Lesson ID 和位置不能通过编辑改（改位置用 reorder），发来的 `sortOrder` 忽略；
   * 发来的 `code` 与现有的不同就整个请求 400，什么都不写。课时名清空就保持为空。
   */
  async updateLesson(id: string, lessonId: string, body: LessonUpdateBody) {
    const code = optionalString(body.code, 'code');
    const title = optionalString(body.title, 'title');
    const description = nullableText(body.description, 'description');
    const textHtml = nullableText(body.textHtml, 'textHtml');
    const requestedLanguage = parseOptionalLanguage(body.language, 'language');
    try {
      await runCourseWrite(this.prisma, id, async (tx) => {
        const lesson = await tx.lesson.findUnique({
          where: { id: lessonId },
          select: { id: true, code: true, courseId: true, archivedAt: true },
        });
        if (!lesson || lesson.courseId !== id || lesson.archivedAt) {
          throw new NotFoundException({
            code: 'LESSON_NOT_FOUND',
            message: 'Lesson not found',
          });
        }
        if (
          code !== undefined &&
          code.trim() &&
          code.trim().toUpperCase() !== lesson.code.toUpperCase()
        ) {
          throw new BadRequestException({
            code: 'LESSON_ID_IMMUTABLE',
            message: 'Lesson ID cannot be changed.',
            details: { field: 'code' },
          });
        }
        const course = await tx.commerceCourse.findUniqueOrThrow({
          where: { id },
          select: { defaultContentLanguage: true },
        });
        const language = requestedLanguage ?? course.defaultContentLanguage;
        if (
          title !== undefined ||
          description !== undefined ||
          textHtml !== undefined
        ) {
          // 只写本次提交的字段：先读后整行写回会在并发保存（例如标题与正文
          // 同时提交）时用旧值互相覆盖，把正文 textHtml 清空并连带删除文本学习点。
          await tx.lessonLocalization.upsert({
            where: { lessonId_language: { lessonId, language } },
            create: {
              lessonId,
              language,
              title: title ?? '',
              description: description ?? null,
              textHtml: textHtml ?? null,
            },
            update: {
              ...(title !== undefined ? { title } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(textHtml !== undefined ? { textHtml } : {}),
            },
          });
          if (textHtml !== undefined) {
            // 盖章后的正文在同一事务里存好；detail() 读回的就是盖过章的那份
            await syncTextPointsInTx(tx, lessonId, language, textHtml);
          }
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
    return this.detail(id);
  }

  async deleteLesson(id: string, lessonId: string) {
    await runCourseWrite(this.prisma, id, (tx) =>
      this.removeLesson(tx, id, lessonId),
    );
    return this.detail(id);
  }

  private async removeLesson(tx: CourseTx, id: string, lessonId: string) {
    const lesson = await tx.lesson.findUnique({
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
    // 重复点击时第二次删不到就�?404 返回
    const removed = await tx.lesson.updateMany({
      where: { id: lessonId, courseId: id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (removed.count === 0) {
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found',
      });
    }
    // 试看行不删：线上版本里这节课还在，试看设置要到 Publish 才一起变；
    // 剩下的启用课时位置重排为 1..N，不留空档。
    const remaining = await tx.lesson.findMany({
      where: { courseId: id, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, sortOrder: true },
    });
    for (const [index, row] of remaining.entries()) {
      if (row.sortOrder !== index + 1) {
        await tx.lesson.update({
          where: { id: row.id },
          data: { sortOrder: index + 1 },
        });
      }
    }
  }

  async reorderLessons(id: string, lessonIds: string[]) {
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
    // 只动本课程的课时：别的课程的课时 id 或不存在�?id 整批拒绝�?04），不留半截排序
    await runCourseWrite(this.prisma, id, async (tx) => {
      const active = await tx.lesson.findMany({
        where: { courseId: id, archivedAt: null },
        select: { id: true },
      });
      const activeIds = new Set(active.map((row) => row.id));
      if (lessonIds.some((lessonId) => !activeIds.has(lessonId))) {
        throw new NotFoundException({
          code: 'LESSON_NOT_FOUND',
          message: 'Lesson not found',
        });
      }
      // 要给出全部启用课时的新顺序：缺一个就 400，不留半截排序。
      if (lessonIds.length !== activeIds.size) {
        throw new BadRequestException({
          code: 'LESSON_ORDER_INCOMPLETE',
          message: 'List every lesson of the course exactly once.',
          details: { expected: activeIds.size, received: lessonIds.length },
        });
      }
      for (const [index, lessonId] of lessonIds.entries()) {
        await tx.lesson.update({
          where: { id: lessonId },
          data: { sortOrder: index + 1 },
        });
      }
    });
    return this.detail(id);
  }

  private toSummary(row: {
    id: string;
    code: string;
    slug: string;
    defaultContentLanguage: string;
    learningMode: string;
    learningLanguages: unknown;
    lifecycleStatus: string;
    liveStatus: string;
    liveVersionId: string | null;
    hasDraft: boolean;
    trialEnabled: boolean;
    updatedAt: Date;
    category: { id: string; name: string; localized: unknown } | null;
    localizations: {
      language: string;
      title: string;
      shortDescription: string | null;
    }[];
    _count: { lessons: number };
  }) {
    // localizations 的返回顺序不稳定（没有 orderBy，Postgres 堆顺序可能因更新而改变），
    // 若直接取 [0]，可能拿到「添加学习语言」时以空标题占位的本地化记录，导致列表里
    // 课程名为空。选择规则见 pickSummaryLocalization。
    const localized = pickSummaryLocalization(
      row.localizations,
      row.defaultContentLanguage,
    );
    const title = summaryTitle(row.localizations, row.defaultContentLanguage, {
      slug: row.slug,
      code: row.code,
    });
    return {
      id: row.id,
      code: row.code,
      slug: row.slug,
      title,
      subtitle: localized?.shortDescription ?? null,
      category: categoryRef(row.category),
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
