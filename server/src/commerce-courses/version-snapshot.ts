import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatApplicationCode,
  formatKnowledgeCode,
  lessonNumber,
} from './code-allocator';
import { defaultLanguageRows, defaultLanguageTest } from './lesson-tests';
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
    /** 课时内的显示顺序；展品有顺序之前拍的旧快照没有这一项，按数组顺序当作顺序。 */
    sortOrder?: number;
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
  /** 展品和时间点都可以还没填（没填完也可以保存），读者按 null 处理为"未选 / 未填"。 */
  triggers: Array<{
    exhibitCode: string | null;
    language: string;
    timeSeconds: number | null;
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
          exhibits: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] },
          learningPoints: { orderBy: { sortOrder: 'asc' } },
          triggers: {
            orderBy: [{ timeSeconds: 'asc' }, { sortOrder: 'asc' }],
          },
          readings: { orderBy: { sortOrder: 'asc' } },
          questions: { orderBy: { sortOrder: 'asc' } },
          applicationTests: true,
        },
      },
    },
  });
  if (!course)
    throw new NotFoundException({
      code: 'COURSE_NOT_FOUND',
      message: 'Course not found',
    });
  // 测试按语言存；快照在 B14 之前只带默认内容语言的那一份。
  const testLanguage = course.defaultContentLanguage;

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
            sortOrder: exhibit.sortOrder,
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
          triggers: lesson.triggers.map((trigger) => ({
            exhibitCode: trigger.exhibitId
              ? (exhibitCodeById.get(trigger.exhibitId) ?? null)
              : null,
            language: trigger.language,
            timeSeconds: trigger.timeSeconds,
          })),
          readings: lesson.readings.map((reading) => ({
            language: reading.language,
            type: reading.type,
            title: reading.title,
            author: reading.author,
            whyRecommended: reading.whyRecommended,
            sortOrder: reading.sortOrder,
          })),
          questions: defaultLanguageRows(lesson.questions, testLanguage).map(
            (question) => ({
              code: question.code,
              question: question.question,
              referenceAnswer: question.referenceAnswer,
              sortOrder: question.sortOrder,
              enabled: question.enabled,
            }),
          ),
          applicationTest: capturedTest(
            defaultLanguageTest(lesson.applicationTests, testLanguage),
          ),
        };
      }),
    },
  };
}

function capturedTest(
  test: {
    scenario: string;
    referenceAnswer: string | null;
    enabled: boolean;
  } | null,
): SnapshotLesson['applicationTest'] {
  return test
    ? {
        scenario: test.scenario,
        referenceAnswer: test.referenceAnswer,
        enabled: test.enabled,
      }
    : null;
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
    // 带 sortOrder 的快照按它排；旧快照没有，数组顺序就是顺序。位置重新编成 1..N。
    const exhibitsInOrder = lesson.exhibits.every(
      (exhibit) => typeof exhibit.sortOrder === 'number',
    )
      ? [...lesson.exhibits].sort(
          (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
        )
      : lesson.exhibits;
    for (const [index, exhibit] of exhibitsInOrder.entries()) {
      const created = await tx.exhibit.create({
        data: {
          lessonId,
          courseId,
          sortOrder: index + 1,
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
      await tx.exhibitTrigger.create({
        data: {
          lessonId,
          exhibitId: trigger.exhibitCode
            ? (exhibitIdByCode.get(trigger.exhibitCode) ?? null)
            : null,
          language: trigger.language,
          timeSeconds: trigger.timeSeconds,
        },
      });
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
    // 题目编号在课程内唯一：旧快照里的编号（每个课时都从 K-0001 起）可能已被别的课时占用，
    // 占用了就按 K-{课时号}{序号} 顺延，没占用就保留快照里的编号。
    const lessonNo = lessonNumber(lesson.code, lesson.sortOrder);
    const takenKnowledge = new Set(
      (
        await tx.knowledgeQuestion.findMany({
          where: { courseId },
          select: { code: true },
        })
      ).map((row) => row.code),
    );
    let sequence = 0;
    for (const question of lesson.questions) {
      let code = question.code;
      while (!code || takenKnowledge.has(code)) {
        sequence += 1;
        code = formatKnowledgeCode(lessonNo, sequence);
      }
      takenKnowledge.add(code);
      await tx.knowledgeQuestion.create({
        data: {
          lessonId,
          courseId,
          language: snapshot.course.defaultContentLanguage,
          code,
          question: question.question,
          referenceAnswer: question.referenceAnswer,
          sortOrder: question.sortOrder,
          enabled: question.enabled,
        },
      });
    }
    if (lesson.applicationTest) {
      const takenApplication = new Set(
        (
          await tx.applicationTest.findMany({
            where: { courseId },
            select: { code: true },
          })
        ).map((row) => row.code),
      );
      let applicationSequence = 1;
      while (
        takenApplication.has(
          formatApplicationCode(lessonNo, applicationSequence),
        )
      ) {
        applicationSequence += 1;
      }
      await tx.applicationTest.create({
        data: {
          lessonId,
          courseId,
          language: snapshot.course.defaultContentLanguage,
          code: formatApplicationCode(lessonNo, applicationSequence),
          scenario: lesson.applicationTest.scenario,
          referenceAnswer: lesson.applicationTest.referenceAnswer,
          enabled: lesson.applicationTest.enabled,
        },
      });
    }
  }
}

interface CompletenessTrial {
  trialEnabled: boolean;
  trialRows: Array<{
    lessonId: string;
    status?: string | null;
    videoCutoffSeconds?: number | null;
    textCutoffLearningPointId?: string | null;
  }>;
}

/** TrialService.get 的结果 → 完成度要看的试看设置（试看不在快照里，随课程当前设置读取）。 */
export function completenessTrial(trial: {
  enabled: boolean;
  rows: Array<{
    inTrial: boolean;
    lessonId: string;
    status?: string | null;
    videoCutoffSeconds?: number | null;
    textCutoffLearningPointId?: string | null;
  }>;
}): CompletenessTrial {
  return {
    trialEnabled: trial.enabled,
    trialRows: trial.rows
      .filter((row) => row.inTrial)
      .map((row) => ({
        lessonId: row.lessonId,
        status: row.status,
        videoCutoffSeconds: row.videoCutoffSeconds,
        textCutoffLearningPointId: row.textCutoffLearningPointId,
      })),
  };
}

/**
 * 快照 → 完成度输入。草稿、线上版本、导出检查和预览都先拍快照再走这里，
 * 所以同一份内容在哪里算出的 issues 都一样。
 */
export function snapshotToCompletenessInput(
  snapshot: VersionSnapshot,
  trial: CompletenessTrial,
  options: { brokenAssetIds?: ReadonlySet<string> } = {},
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
      code: lp.code,
      title: lp.title,
      timeSeconds: lp.timeSeconds,
    })),
    triggers: (lesson.triggers ?? []).map((trigger) => ({
      language: trigger.language,
      exhibitCode: trigger.exhibitCode,
      timeSeconds: trigger.timeSeconds,
    })),
    exhibits: (lesson.exhibits ?? []).map((exhibit) => ({
      code: exhibit.code,
      type: exhibit.type,
      mediaAssetId: exhibit.mediaAssetId,
      thumbnailAssetId: exhibit.thumbnailAssetId,
      localized: exhibit.localized,
    })),
    readings: lesson.readings ?? [],
    questions: lesson.questions,
    applicationTest: lesson.applicationTest,
  }));
  return {
    categoryId: snapshot.course.categoryId,
    coverAssetId: snapshot.course.coverAssetId,
    learningMode: snapshot.course.learningMode,
    learningLanguages: snapshot.course.learningLanguages,
    localizations,
    lessons,
    trialEnabled: trial.trialEnabled,
    trialRows: trial.trialRows,
    brokenAssetIds: options.brokenAssetIds,
  };
}

/**
 * 这门课里文件已损坏或丢失的资产（CourseMediaAsset.brokenAt 非空）。
 * 完成度据此把封面、视频、展品文件标成 "This file is missing or damaged"。
 */
export async function loadBrokenAssetIds(
  prisma: PrismaService | Prisma.TransactionClient,
  courseId: string,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.courseMediaAsset.findMany({
    where: { courseId, brokenAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}
