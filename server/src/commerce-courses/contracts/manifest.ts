/**
 * 课程包契约（Package Spec v1）——见 docs/Course_Module_Import_Export_Design.md §4/§16。
 * 导入/导出、manifest 校验、v2 编辑器共用这些类型。
 */

export type PackageLanguage = 'en-GB' | 'zh-CN' | (string & {});

export type ExhibitType = 'IMAGE' | 'VIDEO' | 'MODEL3D';
export type ReadingType = 'BOOK' | 'ARTICLE' | 'PAPER';
export type LearningMode = 'VIDEO_ONLY' | 'TEXT_ONLY' | 'VIDEO_AND_TEXT';
export type TrialRowStatus = 'READY' | 'RE_CONFIRM' | 'LOCKED';

export interface PackageVideoLearningPoint {
  code: string;
  timeSeconds: number;
  title: string;
}

export interface PackageTextLearningPoint {
  code: string;
  heading: string;
  level?: number;
}

export interface PackageExhibitTrigger {
  timeSeconds: number;
  exhibitRef: string;
}

export interface PackageVideo {
  file: string;
  durationSeconds?: number;
  learningPoints: PackageVideoLearningPoint[];
  exhibitTriggers?: PackageExhibitTrigger[];
}

export interface PackageText {
  html: string;
  learningPoints: PackageTextLearningPoint[];
}

export interface PackageLessonLocalization {
  title: string;
  description?: string;
  video?: PackageVideo | null;
  text?: PackageText | null;
}

export interface PackageExhibit {
  code: string;
  type: ExhibitType;
  file?: string;
  thumbnail?: string;
  source?: string;
  localized: Record<string, { title: string; description?: string }>;
}

export interface PackageReading {
  type: ReadingType;
  title: string;
  author?: string;
  why?: string;
}

export interface PackageKnowledgeQuestion {
  code: string;
  question: string;
  referenceAnswer?: string;
}

export interface PackageLesson {
  code: string;
  order: number;
  localized: Record<string, PackageLessonLocalization>;
  exhibits?: PackageExhibit[];
  recommendedReading?: Record<string, PackageReading[]>;
  knowledgeTest?: { enabled: boolean; questions: PackageKnowledgeQuestion[] };
  applicationTest?: {
    enabled: boolean;
    scenario: string;
    referenceAnswer?: string;
  };
}

export interface PackageCourseLocalization {
  title: string;
  shortDescription?: string;
  overview?: string;
  whatYouLearn?: string[];
  provides?: unknown[];
}

export interface PackageTrial {
  enabled: boolean;
  lessons: {
    lessonRef: string;
    videoCutoffSeconds?: number | null;
    textCutoffLearningPoint?: string | null;
    status?: TrialRowStatus;
  }[];
}

export interface PackageCourse {
  code: string;
  slug: string;
  category: string;
  learningMode: LearningMode;
  learningLanguages: PackageLanguage[];
  defaultContentLanguage: PackageLanguage;
  cover?: string;
  localized: Record<string, PackageCourseLocalization>;
  lessons: PackageLesson[];
  trial?: PackageTrial;
}

export interface PackageManifest {
  format: 'lg-course-package';
  formatVersion: number;
  packageId: string;
  exportedAt: string;
  source: { environment?: string; courseCode?: string; sourceVersion?: string };
  contentHash?: string;
  incomplete: boolean;
  course: PackageCourse;
}

export const PACKAGE_FORMAT = 'lg-course-package';
export const PACKAGE_FORMAT_VERSION = 1;

export interface PackageValidationIssue {
  level: 'error' | 'warning';
  code: string;
  path?: string;
  message: string;
}

export interface PackageValidationReport {
  errors: PackageValidationIssue[];
  warnings: PackageValidationIssue[];
  incomplete: boolean;
}
