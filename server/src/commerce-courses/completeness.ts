/**
 * 课程完成度（PRD §10 / §15 / §20）。
 *
 * 三个步骤：Course Information / Course Content / Trial。
 * 同一套规则用于：编辑器步骤条、Publish 门禁、Export 门禁。
 * 工作区（草稿）与版本快照都归一化成这里的输入形状，避免两套判断。
 */

export interface ContentLessonLocalization {
  language: string;
  title?: string | null;
  description?: string | null;
  videoAssetId?: string | null;
  video?: { id: string } | null;
  videoDurationSeconds?: number | null;
  textHtml?: string | null;
}

export interface ContentLesson {
  id: string;
  code: string;
  sortOrder: number;
  archivedAt?: Date | string | null;
  localizations: ContentLessonLocalization[];
  learningPoints?: Array<{ language: string; source: string }>;
  questions?: Array<{
    question?: string | null;
    referenceAnswer?: string | null;
  }>;
  applicationTest?: {
    scenario?: string | null;
    referenceAnswer?: string | null;
    enabled?: boolean;
  } | null;
}

export interface ContentLocalization {
  language: string;
  title?: string | null;
  shortDescription?: string | null;
  overview?: string | null;
  whatYouLearn?: unknown;
  provides?: unknown;
}

export interface ContentTrialRow {
  lessonId: string;
  status?: string | null;
  videoCutoffSeconds?: number | null;
  textCutoffLearningPointId?: string | null;
}

export interface CompletenessInput {
  categoryId?: string | null;
  learningMode: string;
  learningLanguages: string[];
  localizations: ContentLocalization[];
  lessons: ContentLesson[];
  trialEnabled: boolean;
  trialRows: ContentTrialRow[];
}

export interface LessonCompleteness {
  lessonId: string;
  code: string;
  studyComplete: boolean;
  understandingComplete: boolean;
  missing: string[];
}

export interface StepCompleteness {
  complete: boolean;
  missing: string[];
}

export interface CourseCompleteness {
  steps: {
    courseInformation: StepCompleteness;
    content: StepCompleteness & { lessons: LessonCompleteness[] };
    trial: StepCompleteness;
  };
  completedSteps: number;
  /** Publish 允许不完整，但必须满足：CI 完成 + 至少 1 个 Lesson 的 Study 完成 */
  canPublish: boolean;
  publishBlockers: string[];
}

const MODE_HAS_VIDEO = (mode: string) => mode !== 'TEXT_ONLY';
const MODE_HAS_TEXT = (mode: string) => mode !== 'VIDEO_ONLY';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function videoId(loc: ContentLessonLocalization): string | null {
  return loc.videoAssetId ?? loc.video?.id ?? null;
}

export function computeCompleteness(
  input: CompletenessInput,
): CourseCompleteness {
  const lessons = input.lessons.filter((lesson) => !lesson.archivedAt);

  // ===== Step 1: Course Information =====
  const ciMissing: string[] = [];
  if (!input.categoryId) ciMissing.push('Category is required.');
  if (input.learningLanguages.length === 0)
    ciMissing.push('At least one learning language is required.');
  for (const language of input.learningLanguages) {
    const loc = input.localizations.find((row) => row.language === language);
    if (!loc) {
      ciMissing.push(`Course information is missing for ${language}.`);
      continue;
    }
    if (!text(loc.title)) ciMissing.push(`Title is required (${language}).`);
    if (!text(loc.shortDescription))
      ciMissing.push(`Short description is required (${language}).`);
    if (!text(loc.overview))
      ciMissing.push(`Overview is required (${language}).`);
    if (listLength(loc.whatYouLearn) < 4)
      ciMissing.push(
        `Add at least 4 items to What you'll learn (${language}).`,
      );
    const providesCount = listLength(loc.provides);
    if (providesCount < 4)
      ciMissing.push(
        `Add at least 4 items to This course provides (${language}).`,
      );
    if (providesCount > 6)
      ciMissing.push(
        `This course provides allows at most 6 items (${language}).`,
      );
  }
  const courseInformation: StepCompleteness = {
    complete: ciMissing.length === 0,
    missing: ciMissing,
  };

  // ===== Step 2: Course Content =====
  const lessonResults: LessonCompleteness[] = lessons.map((lesson) => {
    const studyMissing: string[] = [];
    const understandingMissing: string[] = [];
    const lps = lesson.learningPoints ?? [];

    for (const language of input.learningLanguages) {
      const loc = lesson.localizations.find((row) => row.language === language);
      if (!loc) {
        studyMissing.push(
          `Lesson ${lesson.code}: missing ${language} content.`,
        );
        continue;
      }
      if (!text(loc.title))
        studyMissing.push(
          `Lesson ${lesson.code}: title is required (${language}).`,
        );
      if (!text(loc.description))
        studyMissing.push(
          `Lesson ${lesson.code}: description is required (${language}).`,
        );
      if (MODE_HAS_VIDEO(input.learningMode)) {
        if (!videoId(loc))
          studyMissing.push(
            `Lesson ${lesson.code}: video is required (${language}).`,
          );
        if (!loc.videoDurationSeconds || loc.videoDurationSeconds <= 0) {
          studyMissing.push(
            `Lesson ${lesson.code}: video duration is missing (${language}).`,
          );
        }
        if (
          !lps.some((lp) => lp.language === language && lp.source === 'VIDEO')
        ) {
          studyMissing.push(
            `Lesson ${lesson.code}: add at least 1 video learning point (${language}).`,
          );
        }
      }
      if (MODE_HAS_TEXT(input.learningMode)) {
        if (!text(loc.textHtml))
          studyMissing.push(
            `Lesson ${lesson.code}: text content is required (${language}).`,
          );
        if (
          !lps.some((lp) => lp.language === language && lp.source === 'TEXT')
        ) {
          studyMissing.push(
            `Lesson ${lesson.code}: add at least 1 text learning point (${language}).`,
          );
        }
      }
    }

    const questions = lesson.questions ?? [];
    for (const [index, question] of questions.entries()) {
      if (!text(question.question))
        understandingMissing.push(
          `Lesson ${lesson.code}: knowledge question ${index + 1} needs a question.`,
        );
      if (!text(question.referenceAnswer)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: knowledge question ${index + 1} needs a reference answer.`,
        );
      }
    }
    if (lesson.applicationTest && lesson.applicationTest.enabled !== false) {
      if (!text(lesson.applicationTest.scenario)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: application test needs a question.`,
        );
      }
      if (!text(lesson.applicationTest.referenceAnswer)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: application test needs a reference answer.`,
        );
      }
    }

    return {
      lessonId: lesson.id,
      code: lesson.code,
      studyComplete: studyMissing.length === 0,
      understandingComplete: understandingMissing.length === 0,
      missing: [...studyMissing, ...understandingMissing],
    };
  });

  const contentMissing: string[] = [];
  if (lessons.length === 0) contentMissing.push('Add at least 1 lesson.');
  for (const result of lessonResults) {
    if (!result.studyComplete) {
      contentMissing.push(
        `Lesson ${result.code}: Study & Exploration is incomplete.`,
      );
    }
    if (result.understandingComplete === false) {
      contentMissing.push(
        `Lesson ${result.code}: Understanding is incomplete.`,
      );
    }
  }
  const content = {
    complete: contentMissing.length === 0,
    missing: contentMissing,
    lessons: lessonResults,
  };

  // ===== Step 3: Trial =====
  const trialMissing: string[] = [];
  if (input.trialEnabled) {
    const ordered = [...lessons].sort((a, b) => a.sortOrder - b.sortOrder);
    const trialRows = input.trialRows.filter((row) =>
      ordered.some((lesson) => lesson.id === row.lessonId),
    );
    if (ordered.length === 0) {
      trialMissing.push('Add lessons before configuring trial.');
    } else if (trialRows.length === 0) {
      trialMissing.push('Select at least the first lesson for trial.');
    } else {
      const firstIds = ordered
        .slice(0, trialRows.length)
        .map((lesson) => lesson.id);
      const trialIds = trialRows.map((row) => row.lessonId);
      if (!firstIds.every((id) => trialIds.includes(id))) {
        trialMissing.push(
          'Trial lessons must start from Lesson 1 and be consecutive.',
        );
      }
      for (const row of trialRows) {
        if (row.status === 'LOCKED') {
          trialMissing.push('Trial contains a locked lesson.');
        }
        if (row.status === 'RE_CONFIRM') {
          trialMissing.push('Trial cut-off needs re-confirmation.');
        }
        if (
          MODE_HAS_VIDEO(input.learningMode) &&
          (row.videoCutoffSeconds ?? 0) <= 0
        ) {
          trialMissing.push('Video trial cut-off is required.');
        }
        if (
          MODE_HAS_TEXT(input.learningMode) &&
          !row.textCutoffLearningPointId
        ) {
          trialMissing.push('Text trial cut-off is required.');
        }
      }
    }
  }
  const trial: StepCompleteness = {
    complete: trialMissing.length === 0,
    missing: trialMissing,
  };

  const completedSteps = [courseInformation, content, trial].filter(
    (step) => step.complete,
  ).length;

  // ===== Publish gate（PRD §15）=====
  const publishBlockers: string[] = [];
  if (!courseInformation.complete)
    publishBlockers.push('Complete Course Information first.');
  if (!lessonResults.some((result) => result.studyComplete)) {
    publishBlockers.push('Complete at least 1 lesson first.');
  }

  return {
    steps: { courseInformation, content, trial },
    completedSteps,
    canPublish: publishBlockers.length === 0,
    publishBlockers,
  };
}

/** 导出要求三步全部完成（PRD §16）。 */
export function canExport(completeness: CourseCompleteness): boolean {
  return (
    completeness.steps.courseInformation.complete &&
    completeness.steps.content.complete &&
    completeness.steps.trial.complete
  );
}
