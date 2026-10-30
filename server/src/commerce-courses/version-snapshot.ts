import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CompletenessInput,
  ContentLesson,
  ContentLocalization,
} from './completeness';

/**
 * 版本快照（PRD §15.4）。
 *
 * 快照保存课程信息、全部 Lesson/LP/文本/展品/测试/Reading 和媒体引用；
 * **不含试看与价格**（PRD §14：试看/价格不属于版本快照，Restore 不改变它们）。
 * 媒体按资产 ID 引用，未更换的文件在各版本间共用。
 */
export interface VersionSnapshot {
  formatVersion: 2;
  capturedAt: string;
  course: {
    code: string;
    slug: string;
    categoryId: string | null;
    coverAssetId: string | null;
    learningMode: string;
    defaultContentLanguage: string;
    learningLanguages: string[];
    localizations: Array<{
      language: string;
      title: string;
      shortDescription: string | null;
      overview: string | null;
      whatYouLearn: unknown;
      provides: unknown;
    }>;
    lessons: SnapshotLesson[];
  };
}

export interface SnapshotLesson {
  id: string;
  code: string;
  sortOrder: number;
  localizations: Array<{
    language: string;
    title: string;
    description: string | null;
    videoAssetId: string | null;
    videoDurationSeconds: number | null;
    textHtml: string | null;
    textLearningPoints: unknown;
  }>;
  exhibits: Array<{
    code: string;
    type: string;
    mediaAssetId: string | null;
    thumbnailAssetId: string | null;
    sourceText: string | null;
    localized: unknown;
  }>;
  learningPoints: Array<{
    language: string;
    code: string;
    title: string;
    source: string;
    timeSeconds: number | null;
    anchorHeading: string | null;
    sortOrder: number;
  }>;
  triggers: Array<{
    exhibitCode: string;
    language: string;
    timeSeconds: number;
  }>;
  readings: Array<{
    language: string;
    type: string;
    title: string;
    author: string | null;
    whyRecommended: string | null;
    sortOrder: number;
  }>;
  questions: Array<{
    code: string;
    question: string;
    referenceAnswer: string | null;
    sortOrder: number;
    enabled: boolean;
  }>;
  applicationTest: {
    scenario: string;
    referenceAnswer: string | null;
    enabled: boolean;
  } | null;
}

export async function captureVersionSnapshot(
  prisma: PrismaService | Prisma.TransactionClient,
  courseId: string,
): Promise<VersionSnapshot> {
  const course = await prisma.commerceCourse.findUnique({
    where: { id: courseId },
    include: {
      localizations: true,
      lessons: {
        where: { archivedAt: null },
        orderBy: { sortOrder: 'asc' },
        include: {
          localizations: true,
          exhibits: true,
          learningPoints: { orderBy: { sortOrder: 'asc' } },
          triggers: true,
          readings: { orderBy: { sortOrder: 'asc' } },
          questions: { orderBy: { sortOrder: 'asc' } },
          applicationTest: true,
        },
      },
    },
  });
  if (!course) throw new Error(`Course ${courseId} not found`);

  return {
    formatVersion: 2,
    capturedAt: new Date().toISOString(),
    course: {
      code: course.code,
      slug: course.slug,
      categoryId: course.categoryId,
      coverAssetId: course.coverAssetId,
      learningMode: course.learningMode,
      defaultContentLanguage: course.defaultContentLanguage,
      learningLanguages: (course.learningLanguages as string[]) ?? [],
      localizations: course.localizations.map((loc) => ({
        language: loc.language,
        title: loc.title,
        shortDescription: loc.shortDescription,
        overview: loc.overview,
        whatYouLearn: loc.whatYouLearn,
        provides: loc.provides,
      })),
      lessons: course.lessons.map((lesson) => {
        const exhibitCodeById = new Map(
          lesson.exhibits.map((exhibit) => [exhibit.id, exhibit.code]),
        );
        return {
          id: lesson.id,
          code: lesson.code,
          sortOrder: lesson.sortOrder,
          localizations: lesson.localizations.map((loc) => ({
            language: loc.language,
            title: loc.title,
            description: loc.description,
            videoAssetId: loc.videoAssetId,
            videoDurationSeconds: loc.videoDurationSeconds,
            textHtml: loc.textHtml,
            textLearningPoints: loc.textLearningPoints,
          })),
          exhibits: lesson.exhibits.map((exhibit) => ({
            code: exhibit.code,
            type: exhibit.type,
            mediaAssetId: exhibit.mediaAssetId,
            thumbnailAssetId: exhibit.thumbnailAssetId,
            sourceText: exhibit.sourceText,
            localized: exhibit.localized,
          })),
          learningPoints: lesson.learningPoints.map((lp) => ({
            language: lp.language,
            code: lp.code,
            title: lp.title,
            source: lp.source,
            timeSeconds: lp.timeSeconds,
            anchorHeading: lp.anchorHeading,
            sortOrder: lp.sortOrder,
          })),
          triggers: lesson.triggers
            .map((trigger) => ({
              exhibitCode: exhibitCodeById.get(trigger.exhibitId) ?? '',
              language: trigger.language,
              timeSeconds: trigger.timeSeconds,
            }))
            .filter((trigger) => Boolean(trigger.exhibitCode)),
          readings: lesson.readings.map((reading) => ({
            language: reading.language,
            type: reading.type,
            title: reading.title,
            author: reading.author,
            whyRecommended: reading.whyRecommended,
            sortOrder: reading.sortOrder,
          })),
          questions: lesson.questions.map((question) => ({
            code: question.code,
            question: question.question,
            referenceAnswer: question.referenceAnswer,
            sortOrder: question.sortOrder,
            enabled: question.enabled,
          })),
          applicationTest: lesson.applicationTest
            ? {
                scenario: lesson.applicationTest.scenario,
                referenceAnswer: lesson.applicationTest.referenceAnswer,
                enabled: lesson.applicationTest.enabled,
              }
            : null,
        };
      }),
    },
  };
}

/**
 * 把快照写回课程工作区（草稿）。用于 Restore / Delete draft / 导入后的整包替换。
 *
 * - Lesson 按 code 复用现有行 ID（课程包只保证 Course ID / Lesson ID，Lesson code 即对外 ID）；
 * - 快照里不存在的 Lesson 设为 archivedAt，学员历史保留；
 * - 媒体资产只引用、不复制；试看与价格不在此处改动。
 */
export async function applyVersionSnapshot(
  prisma: PrismaService,
  courseId: string,
  snapshot: VersionSnapshot,
): Promise<void> {
  await prisma.$transaction(
    (tx) => applyVersionSnapshotInTx(tx, courseId, snapshot),
    { timeout: 60_000 },
  );
}

/** 在调用方已开启（并已锁住课程行）的事务里写入快照。 */
export async function applyVersionSnapshotInTx(
  tx: Prisma.TransactionClient,
  courseId: string,
  snapshot: VersionSnapshot,
): Promise<void> {
  const course = await tx.commerceCourse.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      learningLanguages: true,
      learningMode: true,
      code: true,
      slug: true,
    },
  });
  if (!course) throw new Error(`Course ${courseId} not found`);

  const currentLanguages = (course.learningLanguages as string[]) ?? [];
  const snapshotLanguages = snapshot.course.learningLanguages ?? [];
  // 学习语言只能追加（PRD §22）
  const learningLanguages = [
    ...currentLanguages,
    ...snapshotLanguages.filter((lang) => !currentLanguages.includes(lang)),
  ];

  const existingLessons = await tx.lesson.findMany({
    where: { courseId },
    select: { id: true, code: true },
  });
  const idByCode = new Map(
    existingLessons.map((lesson) => [lesson.code, lesson.id]),
  );
  const snapshotCodes = new Set(
    snapshot.course.lessons.map((lesson) => lesson.code),
  );

  await tx.lesson.updateMany({
    where: {
      courseId,
      code: { notIn: [...snapshotCodes] },
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });

  await tx.commerceCourse.update({
    where: { id: courseId },
    data: {
      categoryId: snapshot.course.categoryId,
      coverAssetId: snapshot.course.coverAssetId,
      // 创建后锁定 Learning mode（PRD §22），保留当前值
      learningMode: course.learningMode as never,
      defaultContentLanguage: snapshot.course.defaultContentLanguage,
      learningLanguages: learningLanguages,
      hasDraft: true,
    },
  });

  // 课程本地化：快照中的语言覆盖；快照外的语言保留（只增不减）
  for (const loc of snapshot.course.localizations) {
    await tx.courseLocalization.upsert({
      where: { courseId_language: { courseId, language: loc.language } },
      create: {
        courseId,
        language: loc.language,
        title: loc.title,
        shortDescription: loc.shortDescription,
        overview: loc.overview,
        whatYouLearn: (loc.whatYouLearn ?? null) as Prisma.InputJsonValue,
        provides: (loc.provides ?? null) as Prisma.InputJsonValue,
      },
      update: {
        title: loc.title,
        shortDescription: loc.shortDescription,
        overview: loc.overview,
        whatYouLearn: (loc.whatYouLearn ?? null) as Prisma.InputJsonValue,
        provides: (loc.provides ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  for (const lesson of snapshot.course.lessons) {
    const lessonId = idByCode.get(lesson.code) ?? lesson.id;
    await tx.lesson.upsert({
      where: { id: lessonId },
      create: {
        id: lessonId,
        courseId,
        code: lesson.code,
        sortOrder: lesson.sortOrder,
      },
      update: {
        code: lesson.code,
        sortOrder: lesson.sortOrder,
        archivedAt: null,
      },
    });

    await tx.lessonLocalization.deleteMany({ where: { lessonId } });
    await tx.exhibitTrigger.deleteMany({ where: { lessonId } });
    await tx.exhibit.deleteMany({ where: { lessonId } });
    await tx.learningPoint.deleteMany({ where: { lessonId } });
    await tx.recommendedReading.deleteMany({ where: { lessonId } });
    await tx.knowledgeQuestion.deleteMany({ where: { lessonId } });
    await tx.applicationTest.deleteMany({ where: { lessonId } });

    for (const loc of lesson.localizations) {
      await tx.lessonLocalization.create({
        data: {
          lessonId,
          language: loc.language,
          title: loc.title,
          description: loc.description,
          videoAssetId: loc.videoAssetId,
          videoDurationSeconds: loc.videoDurationSeconds,
          textHtml: loc.textHtml,
          textLearningPoints: (loc.textLearningPoints ??
            null) as Prisma.InputJsonValue,
        },
      });
    }

    const exhibitIdByCode = new Map<string, string>();
    for (const exhibit of lesson.exhibits) {
      const created = await tx.exhibit.create({
        data: {
          lessonId,
          code: exhibit.code,
          type: exhibit.type as never,
          mediaAssetId: exhibit.mediaAssetId,
          thumbnailAssetId: exhibit.thumbnailAssetId,
          sourceText: exhibit.sourceText,
          localized: exhibit.localized ?? {},
        },
      });
      exhibitIdByCode.set(exhibit.code, created.id);
    }

    for (const lp of lesson.learningPoints) {
      await tx.learningPoint.create({
        data: {
          lessonId,
          language: lp.language,
          code: lp.code,
          title: lp.title,
          source: lp.source as never,
          timeSeconds: lp.timeSeconds,
          anchorHeading: lp.anchorHeading,
          sortOrder: lp.sortOrder,
        },
      });
    }
    for (const trigger of lesson.triggers) {
      const exhibitId = exhibitIdByCode.get(trigger.exhibitCode);
      if (exhibitId) {
        await tx.exhibitTrigger.create({
          data: {
            lessonId,
            exhibitId,
            language: trigger.language,
            timeSeconds: trigger.timeSeconds,
          },
        });
      }
    }
    for (const reading of lesson.readings) {
      await tx.recommendedReading.create({
        data: {
          lessonId,
          language: reading.language,
          type: reading.type as never,
          title: reading.title,
          author: reading.author,
          whyRecommended: reading.whyRecommended,
          sortOrder: reading.sortOrder,
        },
      });
    }
    for (const question of lesson.questions) {
      await tx.knowledgeQuestion.create({
        data: {
          lessonId,
          code: question.code,
          question: question.question,
          referenceAnswer: question.referenceAnswer,
          sortOrder: question.sortOrder,
          enabled: question.enabled,
        },
      });
    }
    if (lesson.applicationTest) {
      await tx.applicationTest.create({
        data: {
          lessonId,
          scenario: lesson.applicationTest.scenario,
          referenceAnswer: lesson.applicationTest.referenceAnswer,
          enabled: lesson.applicationTest.enabled,
        },
      });
    }
  }
}

/** 快照 → 完成度输入（工作区 detail 与快照共用同一套规则）。 */
export function snapshotToCompletenessInput(
  snapshot: VersionSnapshot,
  trial: {
    trialEnabled: boolean;
    trialRows: Array<{
      lessonId: string;
      status?: string | null;
      videoCutoffSeconds?: number | null;
      textCutoffLearningPointId?: string | null;
    }>;
  },
): CompletenessInput {
  const localizations: ContentLocalization[] = snapshot.course.localizations;
  const lessons: ContentLesson[] = snapshot.course.lessons.map((lesson) => ({
    id: lesson.id,
    code: lesson.code,
    sortOrder: lesson.sortOrder,
    localizations: lesson.localizations.map((loc) => ({
      language: loc.language,
      title: loc.title,
      description: loc.description,
      videoAssetId: loc.videoAssetId,
      videoDurationSeconds: loc.videoDurationSeconds,
      textHtml: loc.textHtml,
    })),
    learningPoints: lesson.learningPoints.map((lp) => ({
      language: lp.language,
      source: lp.source,
    })),
    questions: lesson.questions,
    applicationTest: lesson.applicationTest,
  }));
  return {
    categoryId: snapshot.course.categoryId,
    learningMode: snapshot.course.learningMode,
    learningLanguages: snapshot.course.learningLanguages,
    localizations,
    lessons,
    trialEnabled: trial.trialEnabled,
    trialRows: trial.trialRows,
  };
}

/** 工作区 detail → 完成度输入。 */
export function detailToCompletenessInput(detail: {
  categoryId?: string | null;
  learningMode: string;
  learningLanguages: unknown;
  trialEnabled?: boolean;
  localizations: Array<CourseLocalizationLike>;
  lessons: Array<{
    id: string;
    code: string;
    sortOrder: number;
    archivedAt?: Date | null;
    localizations: Array<
      CourseLocalizationLike & {
        videoAssetId?: string | null;
        video?: { id: string } | null;
        videoDurationSeconds?: number | null;
        textHtml?: string | null;
      }
    >;
    learningPoints?: Array<{ language: string; source: string }>;
    questions?: Array<{ question: string; referenceAnswer: string | null }>;
    applicationTest?: {
      scenario: string;
      referenceAnswer: string | null;
      enabled: boolean;
    } | null;
  }>;
  trialRows: Array<{
    lessonId: string;
    status?: string | null;
    videoCutoffSeconds?: number | null;
    textCutoffLearningPointId?: string | null;
  }>;
}): CompletenessInput {
  return {
    categoryId: detail.categoryId ?? null,
    learningMode: detail.learningMode,
    learningLanguages: (detail.learningLanguages as string[]) ?? [],
    localizations: detail.localizations,
    lessons: detail.lessons,
    trialEnabled: Boolean(detail.trialEnabled),
    trialRows: detail.trialRows,
  };
}

interface CourseLocalizationLike {
  language: string;
  title?: string | null;
  shortDescription?: string | null;
  overview?: string | null;
  whatYouLearn?: unknown;
  provides?: unknown;
}
