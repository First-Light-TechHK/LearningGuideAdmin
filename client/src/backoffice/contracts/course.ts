export type StepCompleteness = { complete: boolean; missing: string[] };

export type LessonCompleteness = {
  lessonId: string;
  code: string;
  studyComplete: boolean;
  understandingComplete: boolean;
  missing: string[];
};

export type CourseCompleteness = {
  steps: {
    courseInformation: StepCompleteness;
    content: StepCompleteness & { lessons: LessonCompleteness[] };
    trial: StepCompleteness;
  };
  completedSteps: number;
  canPublish: boolean;
  publishBlockers: string[];
};

export type CourseLocalization = {
  language: string;
  title: string;
  shortDescription: string | null;
  overview: string | null;
  whatYouLearn: unknown;
  provides: unknown;
};

export type LessonLocalization = {
  language: string;
  title: string;
  description: string | null;
  textHtml: string | null;
  videoAssetId?: string | null;
  video: { id: string } | null;
  videoDurationSeconds: number | null;
};

export type Exhibit = {
  id: string;
  code: string;
  type: string;
  media: { id: string } | null;
  thumbnail: { id: string } | null;
  localized: Record<string, { title?: string; description?: string }>;
};

export type Reading = { type: string; title: string; author: string | null; whyRecommended: string | null };
export type Question = { id?: string; code: string; question: string; referenceAnswer: string | null; enabled?: boolean };
export type ApplicationTest = { scenario: string; referenceAnswer: string | null; enabled?: boolean };

export type Lesson = {
  id: string;
  code: string;
  sortOrder: number;
  localizations: LessonLocalization[];
  exhibits: Exhibit[];
  readings: Reading[];
  questions: Question[];
  applicationTest: ApplicationTest | null;
  learningPoints: Array<{ language: string; code: string; title: string; source: string; timeSeconds: number | null }>;
};

export type CoursePlan = {
  id: string;
  name: string;
  termMonths: number;
  amountMinor: number;
  currency: string;
  stripeLookupKey: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
};

export type TrialRow = {
  lessonId: string;
  code: string;
  index: number;
  title: string;
  videoDurationSeconds: number | null;
  inTrial: boolean;
  videoCutoffSeconds: number | null;
  textCutoffLearningPointId: string | null;
  textCutoffCode: string | null;
  status: 'READY' | 'RE_CONFIRM' | 'LOCKED';
  learningPoints: Array<{ id: string; language: string; code: string; title: string }>;
  videoCutoffByLanguage?: Record<string, number | null> | null;
  textCutoffByLanguage?: Record<string, string | null> | null;
};

export type TrialSettings = {
  enabled: boolean;
  learningMode: string;
  learningLanguages: string[];
  rows: TrialRow[];
};

export type CourseDetail = {
  id: string;
  code: string;
  slug: string;
  learningMode: string;
  learningLanguages: string[];
  defaultContentLanguage: string;
  categoryId: string | null;
  category?: { id: string; name: string } | null;
  cover?: { id: string } | null;
  subtitle: string | null;
  lifecycleStatus: string;
  liveStatus: string;
  liveVersionId: string | null;
  hasDraft: boolean;
  trialEnabled: boolean;
  localizations: CourseLocalization[];
  lessons: Lesson[];
  plans: CoursePlan[];
  trialRows: Array<{ lessonId: string; status: string; videoCutoffSeconds: number | null; textCutoffLearningPointId: string | null }>;
  completeness: CourseCompleteness;
};

export type CourseVersion = {
  id: string;
  versionNo: number;
  versionLabel: string;
  versionSeries: number;
  versionMinor: number;
  sourceEnvironment: string | null;
  sourceVersionLabel: string | null;
  wentLiveAt: string | null;
  exportedAt: string | null;
  createdAt: string;
  isLive: boolean;
};

export type HistoryItem = {
  id: string;
  time: string;
  operator: string;
  action: string;
  versionNo: number | null;
  detail: unknown;
};

export type HistoryPage = { items: HistoryItem[]; total: number; page: number; pages: number };

export type CourseSummary = {
  id: string;
  code: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: { id: string; name: string } | null;
  learningMode: string;
  learningLanguages: string[];
  lessonCount: number;
  lifecycleStatus: string;
  liveStatus: string;
  liveVersionId: string | null;
  hasDraft: boolean;
  trialEnabled: boolean;
  published: boolean;
  updatedAt: string;
};

export type CourseList = {
  courses: CourseSummary[];
  total: number;
  page: number;
  pages: number;
  counts: {
    total: number;
    draft: number;
    published: number;
    online: number;
    hidden: number;
    offline: number;
    notPublished: number;
  };
};

export type PreviewLesson = {
  id: string;
  code: string;
  index: number;
  title: string;
  description: string | null;
  videoAssetId: string | null;
  videoDurationSeconds: number | null;
  textHtml: string | null;
  learningPoints: Array<{ code: string; title: string; source: string; timeSeconds: number | null }>;
  exhibits: Array<{ code: string; type: string; mediaAssetId: string | null; title: string; description: string | null }>;
  readings: Array<{ type: string; title: string; author: string | null; whyRecommended: string | null }>;
  knowledgeTest: { enabled: boolean; questions: Array<{ code: string; question: string }> };
  applicationTest: { scenario: string } | null;
  trial: { videoCutoffSeconds: number | null; textCutoffLearningPointId: string | null; status: string } | null;
};

export type PreviewCourse = {
  id: string;
  code: string;
  slug: string;
  versionLabel: string | null;
  category: string | null;
  learningMode: string;
  learningLanguages: string[];
  defaultContentLanguage: string;
  coverUrl: string | null;
  title: string;
  shortDescription: string | null;
  overview: string | null;
  whatYouLearn: unknown;
  provides: unknown;
  localizations: CourseLocalization[];
  lessonCount: number;
  totalDurationSeconds: number;
  lessons: PreviewLesson[];
  trial: { enabled: boolean; available: boolean; rows: TrialRow[] };
  plans: CoursePlan[];
  completeness: CourseCompleteness;
};

export type EnvironmentInfo = {
  label: string;
  publicSiteUrl: string;
  versionNumberingMode: 'sandbox' | 'production';
  stripeConfigured: boolean;
};

export type PopularCourseItem = {
  courseId: string;
  sortOrder: number;
  code: string;
  title: string;
  category: string | null;
  liveStatus: string;
  trialEnabled: boolean;
  coverUrl: string | null;
  invalid: boolean;
};

export type PopularCourses = {
  items: PopularCourseItem[];
  publishedAt: string | null;
  publishedBy: string | null;
};

export type BannerLocalizedEntry = {
  headline?: string;
  subheading?: string;
  buttonLabel?: string;
};

export type DiscoveryBanner = {
  enabled: boolean;
  courseId: string | null;
  localized: Record<string, BannerLocalizedEntry> | null;
  publishedAt: string | null;
  publishedBy: string | null;
  invalid: boolean;
  course: {
    id: string;
    code: string;
    title: string;
    liveStatus: string;
    trialEnabled: boolean;
    coverUrl: string | null;
  } | null;
};

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) =>
          typeof item === 'string' ? item : (item as { title?: string; text?: string } | null)?.title ?? (item as { text?: string } | null)?.text ?? '',
        )
        .filter(Boolean)
    : [];
}

export function providerItems(value: unknown): Array<{ type: string; title: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { type: 'custom', title: item };
    const record = item as { type?: string; title?: string; text?: string };
    return { type: record.type ?? 'custom', title: record.title ?? record.text ?? '' };
  });
}
