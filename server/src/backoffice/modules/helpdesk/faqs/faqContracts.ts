import type {
  FaqCategory,
  FaqSignal,
  HelpdeskLocale,
} from '../../../../contracts/helpdesk-qa';

/**
 * Helpdesk FAQ（Tickets v2 Figma addendum §1）：一条 FAQ 是一条中英双语记录（Figma 1379:299）。
 * 表结构见迁移 20261029090000_helpdesk_faqs；这里是服务层与接口的形状。
 */
export const FAQ_STATUSES = ['published', 'archived'] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];

export const FAQ_LIMITS = {
  questionMax: 200,
  answerMax: 4000,
  keywordsMax: 20,
  keywordMax: 40,
  searchMax: 200,
  /** 员工端表格每页 10 行（Figma 1379:2）。 */
  pageSize: 10,
  pageSizeMax: 50,
  /** Portal 读列表的 limit 上限（§2）。 */
  publicLimitMax: 100,
  publicLimitDefault: 50,
  candidatesMax: 8,
  /** v5 Part A：每条 FAQ 的信号标签至多这么多个（= FAQ_SIGNALS 的个数）。 */
  signalsMax: 8,
} as const;

export type HelpdeskFaq = {
  id: string;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  /** Markdown 子集（**粗体**、1. 有序、- 无序、[链接](https://… / mailto:)、段落）。 */
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  /** v5 Part A：这条 FAQ 适合哪些学员情境（FAQ_SIGNALS，按 chip 优先级排好、去重）；迁移 20261030080000。 */
  signals: FaqSignal[];
  status: FaqStatus;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FaqRevisionAction = 'create' | 'update' | 'archive';

export type FaqRevision = {
  id: string;
  faqId: string;
  version: number;
  action: FaqRevisionAction;
  employeeId: string | null;
  at: string;
  snapshot: Record<string, unknown>;
};

/** 员工端列表一页。 */
export type FaqPage = {
  faqs: HelpdeskFaq[];
  total: number;
  page: number;
  pageSize: number;
};

/** Portal 读到的公开形状：按语言挑好字段，只含已发布的（§2）。 */
export type PublicFaq = {
  id: string;
  category: FaqCategory;
  popular: boolean;
  question: string;
  answer: string;
  /** v5 Part A（契约 fixture v6，增量）：旧的 Portal 不读。 */
  signals: FaqSignal[];
  updatedAt: string;
};

export type PublishedFaqs = {
  faqs: PublicFaq[];
  etag: string;
};

/** 该语言的问题 / 答案。 */
export function localised(
  faq: Pick<HelpdeskFaq, 'questionEn' | 'answerEn' | 'questionZh' | 'answerZh'>,
  locale: HelpdeskLocale,
): { question: string; answer: string } {
  return locale === 'zh-CN'
    ? { question: faq.questionZh, answer: faq.answerZh }
    : { question: faq.questionEn, answer: faq.answerEn };
}
