import type {
  HelpdeskCategory,
  HelpdeskLocale,
  HelpdeskQuestionStats,
} from '../../../../contracts/helpdesk-qa';

/**
 * Common Questions（Figma addendum §A）：BackOffice 维护的问答库。
 * 表结构见迁移 20261028090000_helpdesk_questions；这里是服务层与接口的形状。
 */
export const QUESTION_STATUSES = ['draft', 'published', 'archived'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_LIMITS = {
  questionMax: 200,
  answerMax: 4000,
  keywordsMax: 20,
  keywordMax: 40,
  searchMax: 200,
  reorderMax: 500,
  candidatesMax: 8,
} as const;

export type HelpdeskQuestion = {
  id: string;
  locale: HelpdeskLocale;
  category: HelpdeskCategory;
  question: string;
  /** 纯文本，保留换行；URL 在渲染时自动成链接。 */
  answer: string;
  keywords: string[];
  status: QuestionStatus;
  /** Portal 联系客服页右栏展示。 */
  featured: boolean;
  sortOrder: number;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 员工端看到的一行：加上推荐计数（来自 helpdesk_suggestions）。 */
export type QuestionView = HelpdeskQuestion & { stats: HelpdeskQuestionStats };

export type RevisionAction =
  'create' | 'update' | 'publish' | 'unpublish' | 'archive';

export type QuestionRevision = {
  id: string;
  questionId: string;
  version: number;
  action: RevisionAction;
  employeeId: string | null;
  at: string;
  snapshot: Record<string, unknown>;
};

/** Portal 读到的公开形状（只含已发布问题）。 */
export type PublicQuestion = Pick<
  HelpdeskQuestion,
  'id' | 'category' | 'question' | 'answer'
>;

export type PublishedQuestions = {
  questions: PublicQuestion[];
  etag: string;
};
