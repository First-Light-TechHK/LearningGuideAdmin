/**
 * 课程完成度（PRD §10 / §15 / §20）。
 *
 * 三个步骤：Course Information / Course Content / Trial。
 * 同一套规则用于：编辑器步骤条、Publish 门禁、Export 门禁。
 * 工作区（草稿）与版本快照都归一化成这里的输入形状，避免两套判断。
 *
 * "未完成"只是算出来的状态：保存时存下填了的内容，缺什么由 `issues` 逐项说明
 * （哪一步、哪一课、哪种语言、哪个字段），页面据此把字段标红。`missing` 是同一批
 * issues 的文字版，给旧页面用。
 */

import { parseTextStructure, stripHtml } from './text-structure';

export interface ContentLessonLocalization {
  language: string;
  title?: string | null;
  description?: string | null;
  videoAssetId?: string | null;
  video?: { id: string } | null;
  videoDurationSeconds?: number | null;
  textHtml?: string | null;
}

export interface ContentLearningPoint {
  language: string;
  source: string;
  code?: string | null;
  title?: string | null;
  timeSeconds?: number | null;
}

/** 展品触发点：展品和时间点都可以还没填。 */
export interface ContentTrigger {
  language: string;
  exhibitCode?: string | null;
  timeSeconds?: number | null;
}

/** 展品（PRD 12.4 / §20 #16）。标题和说明按语言放在 localized 里：{ 'en-GB': { title, description } }。 */
export interface ContentExhibit {
  code: string;
  type?: string | null;
  mediaAssetId?: string | null;
  thumbnailAssetId?: string | null;
  localized?: unknown;
}

/** 延伸阅读（PRD 12.6 / §20 #19）：整门课只有一份英文列表。 */
export interface ContentReading {
  language: string;
  type?: string | null;
  title?: string | null;
  author?: string | null;
  whyRecommended?: string | null;
}

export interface ContentLesson {
  id: string;
  code: string;
  sortOrder: number;
  archivedAt?: Date | string | null;
  localizations: ContentLessonLocalization[];
  learningPoints?: ContentLearningPoint[];
  triggers?: ContentTrigger[];
  exhibits?: ContentExhibit[];
  readings?: ContentReading[];
  /**
   * 测试的"启用"开关。快照还不带这两个开关时留空：
   * 知识题按"有题目就算启用"，应用题按它自己的 enabled。
   */
  knowledgeEnabled?: boolean;
  applicationEnabled?: boolean;
  questions?: Array<{
    code?: string | null;
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
  coverAssetId?: string | null;
  learningMode: string;
  learningLanguages: string[];
  localizations: ContentLocalization[];
  lessons: ContentLesson[];
  trialEnabled: boolean;
  trialRows: ContentTrialRow[];
  /** 文件已损坏或丢失的资产 ID（CourseMediaAsset.brokenAt 非空）。 */
  brokenAssetIds?: ReadonlySet<string>;
}

export type IssueStep = 'COURSE_INFORMATION' | 'COURSE_CONTENT' | 'TRIAL';
export type IssuePart = 'LESSON_INFO' | 'STUDY' | 'UNDERSTANDING';

/**
 * 一项没填完的内容。`field` 是稳定的字段路径（例如 `title`、`learn[3]`、
 * `videoLearningPoints[V3].timeSeconds`、`triggers[2].exhibitId`），`message` 是 PRD 的提示文案。
 */
export interface CompletenessIssue {
  code: string;
  step: IssueStep;
  part?: IssuePart;
  lessonId?: string;
  lessonCode?: string;
  /** 课时在课程里的位置，从 1 起，不含已删除的课时。 */
  lessonPosition?: number;
  language?: string;
  field: string;
  rowKey?: string;
  message: string;
}

export interface LessonCompleteness {
  lessonId: string;
  code: string;
  position: number;
  /** Lesson info（标题、描述，中英文）是否齐全。 */
  infoComplete: boolean;
  /** Study & Exploration 完成：含 Lesson info，Publish 门禁按它判断。 */
  studyComplete: boolean;
  understandingComplete: boolean;
  missing: string[];
  issues: CompletenessIssue[];
}

export interface StepCompleteness {
  complete: boolean;
  missing: string[];
}

export type PublishBlockerCode = 'COURSE_INFORMATION' | 'LESSON_STUDY';

/** Publish 弹窗里"哪些课时还有空"的一行：用课时编号和位置，不带数据库 ID。 */
export interface IncompleteLesson {
  lessonId: string;
  code: string;
  position: number;
  parts: IssuePart[];
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
  /** 与 publishBlockers 一一对应的稳定代码，页面按它判断是哪一项挡住了发布。 */
  publishBlockerCodes: PublishBlockerCode[];
  /** 所有没填完的内容，按步骤、课时顺序排列。 */
  issues: CompletenessIssue[];
  /** 还有内容没填完的课时（含 Lesson info、Study、Understanding），按课时顺序。 */
  incompleteLessons: IncompleteLesson[];
}

const MODE_HAS_VIDEO = (mode: string) => mode !== 'TEXT_ONLY';
const MODE_HAS_TEXT = (mode: string) => mode !== 'VIDEO_ONLY';

/** Course Information 和 Lesson 的标题、描述始终中英文并列必填（PRD L301、L333、§20 #1 #6 #7）。 */
const BILINGUAL_LANGUAGES = ['en-GB', 'zh-CN'] as const;

const PARTS: IssuePart[] = ['LESSON_INFO', 'STUDY', 'UNDERSTANDING'];

const REQUIRED = 'Required';
const AT_LEAST_4 = 'At least 4 items';
const AT_MOST_6 = 'At most 6 items';
const H1_HINT =
  'No learning points found. Set each learning point title as Heading 1 (H1).';
const FILE_BROKEN = 'This file is missing or damaged. Upload it again.';
/** 延伸阅读只有一份英文列表（PRD L411）。 */
const READING_LANGUAGE = 'en-GB';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 列表项的文字：What you'll learn 是字符串，This course provides 是带 title 的对象。 */
function itemText(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  return text((item as { title?: unknown } | null | undefined)?.title);
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function videoId(loc: ContentLessonLocalization): string | null {
  return loc.videoAssetId ?? loc.video?.id ?? null;
}

/** 展品里某种语言的某个字段：localized 形如 { 'en-GB': { title, description } }。 */
function localizedText(
  localized: unknown,
  language: string,
  field: 'title' | 'description',
): string {
  if (!localized || typeof localized !== 'object') return '';
  const entry = (localized as Record<string, unknown>)[language];
  if (!entry || typeof entry !== 'object') return '';
  return text((entry as Record<string, unknown>)[field]);
}

/** 600 → "10:00"（分钟不设上限）。 */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function describe(issue: CompletenessIssue): string {
  const where = [
    issue.lessonCode ? `Lesson ${issue.lessonCode}` : null,
    issue.language ?? null,
    issue.field,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${where}: ${issue.message}`;
}

// ===== Step 1: Course Information =====

function courseInformationIssues(
  input: CompletenessInput,
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  const add = (
    code: string,
    field: string,
    message: string,
    language?: string,
  ) =>
    issues.push({
      code,
      step: 'COURSE_INFORMATION',
      field,
      message,
      ...(language ? { language } : {}),
    });

  if (!input.categoryId) add('REQUIRED', 'category', REQUIRED);
  if (!input.coverAssetId) add('REQUIRED', 'cover', REQUIRED);
  else if (input.brokenAssetIds?.has(input.coverAssetId))
    add('FILE_BROKEN', 'cover', FILE_BROKEN);
  if (input.learningLanguages.length === 0)
    add('REQUIRED', 'learningLanguages', REQUIRED);

  for (const language of BILINGUAL_LANGUAGES) {
    const loc = input.localizations.find((row) => row.language === language);
    if (!text(loc?.title)) add('REQUIRED', 'title', REQUIRED, language);
    if (!text(loc?.shortDescription))
      add('REQUIRED', 'shortDescription', REQUIRED, language);
    if (!text(loc?.overview)) add('REQUIRED', 'overview', REQUIRED, language);
  }

  // 两种语言的列表按位置一一对应：每一行两边都要填；某种语言的行数少了，缺的行在这种语言里标红。
  const lists = [
    { field: 'learn', pick: (loc?: ContentLocalization) => loc?.whatYouLearn },
    { field: 'provides', pick: (loc?: ContentLocalization) => loc?.provides },
  ];
  for (const { field, pick } of lists) {
    const byLanguage = BILINGUAL_LANGUAGES.map((language) => ({
      language,
      items: listOf(
        pick(input.localizations.find((row) => row.language === language)),
      ),
    }));
    const rows = Math.max(...byLanguage.map((entry) => entry.items.length));
    for (const { language, items } of byLanguage) {
      if (items.length < 4) add('MIN_ITEMS', field, AT_LEAST_4, language);
      if (field === 'provides' && items.length > 6)
        add('MAX_ITEMS', field, AT_MOST_6, language);
      for (let index = 0; index < rows; index += 1) {
        if (!itemText(items[index]))
          add('REQUIRED', `${field}[${index}]`, REQUIRED, language);
      }
    }
  }
  return issues;
}

// ===== Step 2: Course Content =====

interface LessonContext {
  lesson: ContentLesson;
  position: number;
}

function lessonIssues(
  input: CompletenessInput,
  { lesson, position }: LessonContext,
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  const add = (
    part: IssuePart,
    code: string,
    field: string,
    message: string,
    extra: { language?: string; rowKey?: string } = {},
  ) =>
    issues.push({
      code,
      step: 'COURSE_CONTENT',
      part,
      lessonId: lesson.id,
      lessonCode: lesson.code,
      lessonPosition: position,
      field,
      message,
      ...extra,
    });

  // Lesson info：标题、描述，中英文并列
  for (const language of BILINGUAL_LANGUAGES) {
    const loc = lesson.localizations.find((row) => row.language === language);
    if (!text(loc?.title))
      add('LESSON_INFO', 'REQUIRED', 'title', REQUIRED, { language });
    if (!text(loc?.description))
      add('LESSON_INFO', 'REQUIRED', 'description', REQUIRED, { language });
  }

  // Study & Exploration：按学习语言
  const points = lesson.learningPoints ?? [];
  const triggers = lesson.triggers ?? [];
  for (const language of input.learningLanguages) {
    const found = lesson.localizations.find((row) => row.language === language);
    const loc: ContentLessonLocalization = found ?? { language };

    if (MODE_HAS_VIDEO(input.learningMode)) {
      const currentVideo = videoId(loc);
      const hasVideo = Boolean(currentVideo);
      const seconds = loc.videoDurationSeconds ?? 0;
      const length = hasVideo && seconds > 0 ? seconds : null;
      if (!hasVideo) {
        add('STUDY', 'VIDEO_REQUIRED', 'video', 'Video is required', {
          language,
        });
      } else if (currentVideo && input.brokenAssetIds?.has(currentVideo)) {
        add('STUDY', 'FILE_BROKEN', 'video', FILE_BROKEN, { language });
      } else if (length === null) {
        add(
          'STUDY',
          'DURATION_UNREADABLE',
          'video.duration',
          'The video length could not be read. Upload the video again.',
          { language },
        );
      }

      const timeIssue = (
        field: string,
        time: number | null | undefined,
        rowKey: string,
      ) => {
        if (time === null || time === undefined) {
          add('STUDY', 'REQUIRED', field, REQUIRED, { language, rowKey });
        } else if (length !== null && time > length) {
          add(
            'STUDY',
            'BEYOND_VIDEO_LENGTH',
            field,
            `Beyond video length (${clock(length)})`,
            { language, rowKey },
          );
        }
      };

      const videoPoints = points.filter(
        (lp) => lp.language === language && lp.source === 'VIDEO',
      );
      if (videoPoints.length === 0) {
        add(
          'STUDY',
          'LEARNING_POINT_REQUIRED',
          'videoLearningPoints',
          'At least 1 learning point',
          { language },
        );
      }
      for (const [index, lp] of videoPoints.entries()) {
        const key = lp.code || `#${index + 1}`;
        const base = `videoLearningPoints[${key}]`;
        if (!text(lp.title))
          add('STUDY', 'REQUIRED', `${base}.title`, REQUIRED, {
            language,
            rowKey: key,
          });
        timeIssue(`${base}.timeSeconds`, lp.timeSeconds, key);
      }

      const languageTriggers = triggers.filter(
        (trigger) => trigger.language === language,
      );
      for (const [index, trigger] of languageTriggers.entries()) {
        const base = `triggers[${index}]`;
        if (!trigger.exhibitCode)
          add(
            'STUDY',
            'CHOOSE_EXHIBIT',
            `${base}.exhibitId`,
            'Choose an exhibit',
            { language, rowKey: String(index) },
          );
        timeIssue(`${base}.timeSeconds`, trigger.timeSeconds, String(index));
      }
    }

    if (MODE_HAS_TEXT(input.learningMode)) {
      const html = loc.textHtml ?? '';
      const headings = parseTextStructure(html);
      if (headings.length === 0 && !stripHtml(html)) {
        add('STUDY', 'TEXT_REQUIRED', 'text', 'Text is required', { language });
      } else if (headings.length === 0) {
        add('STUDY', 'NO_HEADINGS', 'textLearningPoints', H1_HINT, {
          language,
        });
      }
      for (const heading of headings) {
        const key = heading.code ?? `#${heading.index + 1}`;
        const base = `textLearningPoints[${key}]`;
        if (!heading.title) {
          add(
            'STUDY',
            'HEADING_EMPTY',
            `${base}.title`,
            "Title can't be empty",
            { language, rowKey: key },
          );
        } else if (!heading.hasBody) {
          add(
            'STUDY',
            'NO_TEXT_UNDER_HEADING',
            `${base}.body`,
            'No text under this heading',
            { language, rowKey: key },
          );
        }
      }
    }
  }

  // Exhibits：类型、文件、缩略图，以及每种学习语言的标题和说明
  for (const exhibit of lesson.exhibits ?? []) {
    const key = exhibit.code;
    const base = `exhibits[${key}]`;
    if (!text(exhibit.type))
      add('STUDY', 'REQUIRED', `${base}.type`, REQUIRED, { rowKey: key });
    for (const [field, assetId] of [
      ['media', exhibit.mediaAssetId],
      ['thumbnail', exhibit.thumbnailAssetId],
    ] as const) {
      if (!assetId) {
        add('STUDY', 'REQUIRED', `${base}.${field}`, REQUIRED, { rowKey: key });
      } else if (input.brokenAssetIds?.has(assetId)) {
        add('STUDY', 'FILE_BROKEN', `${base}.${field}`, FILE_BROKEN, {
          rowKey: key,
        });
      }
    }
    for (const language of input.learningLanguages) {
      for (const field of ['title', 'description'] as const) {
        if (!localizedText(exhibit.localized, language, field))
          add('STUDY', 'REQUIRED', `${base}.${field}`, REQUIRED, {
            language,
            rowKey: key,
          });
      }
    }
  }

  // Recommended reading：一份英文列表。旧版本里标成别的语言的行，在没有英文行时照样算数。
  const allReadings = lesson.readings ?? [];
  const english = allReadings.filter(
    (row) => row.language === READING_LANGUAGE,
  );
  const readings = english.length > 0 ? english : allReadings;
  if (readings.length === 0) add('STUDY', 'REQUIRED', 'readings', REQUIRED);
  for (const [index, reading] of readings.entries()) {
    for (const field of [
      'type',
      'title',
      'author',
      'whyRecommended',
    ] as const) {
      if (!text(reading[field]))
        add('STUDY', 'REQUIRED', `readings[${index}].${field}`, REQUIRED, {
          rowKey: String(index),
        });
    }
  }

  // Understanding：关闭的测试不产生任何提示；启用的测试要有题目，题和参考答案都要填
  const questions = lesson.questions ?? [];
  if (lesson.knowledgeEnabled !== false) {
    if (lesson.knowledgeEnabled === true && questions.length === 0)
      add('UNDERSTANDING', 'KNOWLEDGE_EMPTY', 'knowledge', REQUIRED);
    for (const [index, question] of questions.entries()) {
      const key = question.code || String(index + 1);
      if (!text(question.question))
        add(
          'UNDERSTANDING',
          'REQUIRED',
          `knowledge[${key}].question`,
          REQUIRED,
          { rowKey: key },
        );
      if (!text(question.referenceAnswer))
        add(
          'UNDERSTANDING',
          'REFERENCE_ANSWER_MISSING',
          `knowledge[${key}].referenceAnswer`,
          'Reference answer missing',
          { rowKey: key },
        );
    }
  }
  const application = lesson.applicationTest;
  if (lesson.applicationEnabled !== false) {
    if (!application) {
      if (lesson.applicationEnabled === true)
        add('UNDERSTANDING', 'APPLICATION_MISSING', 'application', REQUIRED);
    } else if (
      lesson.applicationEnabled === true ||
      application.enabled !== false
    ) {
      if (!text(application.scenario))
        add('UNDERSTANDING', 'REQUIRED', 'application.scenario', REQUIRED);
      if (!text(application.referenceAnswer))
        add(
          'UNDERSTANDING',
          'REFERENCE_ANSWER_MISSING',
          'application.referenceAnswer',
          'Reference answer missing',
        );
    }
  }
  return issues;
}

// ===== Step 3: Trial =====

function trialIssues(
  input: CompletenessInput,
  ordered: LessonContext[],
): CompletenessIssue[] {
  if (!input.trialEnabled) return [];
  const issues: CompletenessIssue[] = [];
  const add = (
    code: string,
    field: string,
    message: string,
    at?: LessonContext,
  ) =>
    issues.push({
      code,
      step: 'TRIAL',
      field,
      message,
      ...(at
        ? {
            lessonId: at.lesson.id,
            lessonCode: at.lesson.code,
            lessonPosition: at.position,
          }
        : {}),
    });

  const trialRows = input.trialRows.filter((row) =>
    ordered.some(({ lesson }) => lesson.id === row.lessonId),
  );
  if (ordered.length === 0) {
    add(
      'TRIAL_NO_LESSONS',
      'trial.lessons',
      'Add lessons before configuring trial.',
    );
    return issues;
  }
  if (trialRows.length === 0) {
    add(
      'TRIAL_NO_SELECTION',
      'trial.lessons',
      'Select at least the first lesson for trial.',
    );
    return issues;
  }
  const firstIds = ordered
    .slice(0, trialRows.length)
    .map(({ lesson }) => lesson.id);
  const trialIds = trialRows.map((row) => row.lessonId);
  if (!firstIds.every((id) => trialIds.includes(id))) {
    add(
      'TRIAL_NOT_CONSECUTIVE',
      'trial.lessons',
      'Trial lessons must start from Lesson 1 and be consecutive.',
    );
  }
  for (const row of trialRows) {
    const at = ordered.find(({ lesson }) => lesson.id === row.lessonId);
    if (row.status === 'LOCKED')
      add(
        'TRIAL_LOCKED',
        'trial.lessons',
        'Trial contains a locked lesson.',
        at,
      );
    if (row.status === 'RE_CONFIRM')
      add(
        'TRIAL_RECONFIRM',
        'trial.lessons',
        'Trial cut-off needs re-confirmation.',
        at,
      );
    if (
      MODE_HAS_VIDEO(input.learningMode) &&
      (row.videoCutoffSeconds ?? 0) <= 0
    )
      add(
        'TRIAL_VIDEO_CUTOFF',
        'trial.cutoff.video',
        'Video trial cut-off is required.',
        at,
      );
    if (MODE_HAS_TEXT(input.learningMode) && !row.textCutoffLearningPointId)
      add(
        'TRIAL_TEXT_CUTOFF',
        'trial.cutoff.text',
        'Text trial cut-off is required.',
        at,
      );
  }
  return issues;
}

export function computeCompleteness(
  input: CompletenessInput,
): CourseCompleteness {
  const ordered: LessonContext[] = input.lessons
    .filter((lesson) => !lesson.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((lesson, index) => ({ lesson, position: index + 1 }));

  const ciIssues = courseInformationIssues(input);
  const courseInformation: StepCompleteness = {
    complete: ciIssues.length === 0,
    missing: ciIssues.map(describe),
  };

  const lessonResults: LessonCompleteness[] = ordered.map((context) => {
    const issues = lessonIssues(input, context);
    const has = (part: IssuePart) => issues.some((i) => i.part === part);
    return {
      lessonId: context.lesson.id,
      code: context.lesson.code,
      position: context.position,
      infoComplete: !has('LESSON_INFO'),
      studyComplete: !has('LESSON_INFO') && !has('STUDY'),
      understandingComplete: !has('UNDERSTANDING'),
      missing: issues.map(describe),
      issues,
    };
  });

  const contentIssues: CompletenessIssue[] = [];
  const contentMissing: string[] = [];
  if (ordered.length === 0) {
    contentMissing.push('Add at least 1 lesson.');
    contentIssues.push({
      code: 'LESSON_REQUIRED',
      step: 'COURSE_CONTENT',
      field: 'lessons',
      message: 'Add at least 1 lesson.',
    });
  }
  for (const result of lessonResults) {
    contentIssues.push(...result.issues);
    if (!result.studyComplete) {
      contentMissing.push(
        `Lesson ${result.code}: Study & Exploration is incomplete.`,
      );
    }
    if (!result.understandingComplete) {
      contentMissing.push(
        `Lesson ${result.code}: Understanding is incomplete.`,
      );
    }
  }
  const content = {
    complete: contentIssues.length === 0,
    missing: contentMissing,
    lessons: lessonResults,
  };

  const trialList = trialIssues(input, ordered);
  const trial: StepCompleteness = {
    complete: trialList.length === 0,
    missing: trialList.map(describe),
  };

  const completedSteps = [courseInformation, content, trial].filter(
    (step) => step.complete,
  ).length;

  // ===== Publish gate（PRD §15）=====
  const publishBlockers: string[] = [];
  const publishBlockerCodes: PublishBlockerCode[] = [];
  if (!courseInformation.complete) {
    publishBlockers.push('Complete Course Information first.');
    publishBlockerCodes.push('COURSE_INFORMATION');
  }
  if (!lessonResults.some((result) => result.studyComplete)) {
    publishBlockers.push('Complete at least 1 lesson first.');
    publishBlockerCodes.push('LESSON_STUDY');
  }

  const incompleteLessons: IncompleteLesson[] = lessonResults
    .filter((result) => result.issues.length > 0)
    .map((result) => ({
      lessonId: result.lessonId,
      code: result.code,
      position: result.position,
      parts: PARTS.filter((part) =>
        result.issues.some((issue) => issue.part === part),
      ),
    }));

  return {
    steps: { courseInformation, content, trial },
    completedSteps,
    canPublish: publishBlockers.length === 0,
    publishBlockers,
    publishBlockerCodes,
    issues: [...ciIssues, ...contentIssues, ...trialList],
    incompleteLessons,
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
