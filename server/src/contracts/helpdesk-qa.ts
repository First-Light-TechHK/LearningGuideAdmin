/**
 * Helpdesk FAQ 的跨域契约（Tickets v2 Figma addendum §1 / §2）。
 *
 * - FAQ 库（helpdesk_faqs）归 BackOffice（admin 角色）写，是唯一写入方；
 * - 推荐（helpdesk_suggestions）归 Agent（agent 角色）写；
 * 两边互不 import 实现（eslint no-restricted-imports），Agent 只经这里的 HelpdeskQaSource
 * 读已发布的 FAQ（候选检索、按 id 取一条）。具体实现由 app.module.ts 组装。
 */
export const HELPDESK_LOCALES = ['en-GB', 'zh-CN'] as const;
export type HelpdeskLocale = (typeof HELPDESK_LOCALES)[number];

/** 工单的 Enquiry Type（Figma 1216:6，Portal 的工单 category）。 */
export const HELPDESK_CATEGORIES = [
  'technical_support',
  'course_content',
  'payments_subscriptions',
  'other',
] as const;
export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

/** FAQ 的分类（Figma 1379:2 / 1387:2；v2 §1）。 */
export const FAQ_CATEGORIES = [
  'account_technical',
  'courses_learning',
  'payments_subscriptions',
  'other',
] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

/** 工单类型 → 同一主题的 FAQ 分类（推荐时同类加权用）。 */
const TICKET_TO_FAQ: Record<HelpdeskCategory, FaqCategory> = {
  technical_support: 'account_technical',
  course_content: 'courses_learning',
  payments_subscriptions: 'payments_subscriptions',
  other: 'other',
};

export function isHelpdeskLocale(value: unknown): value is HelpdeskLocale {
  return (HELPDESK_LOCALES as readonly unknown[]).includes(value);
}

export function isHelpdeskCategory(value: unknown): value is HelpdeskCategory {
  return (HELPDESK_CATEGORIES as readonly unknown[]).includes(value);
}

export function isFaqCategory(value: unknown): value is FaqCategory {
  return (FAQ_CATEGORIES as readonly unknown[]).includes(value);
}

/** 工单类型或 FAQ 分类 → FAQ 分类；都不是返回 null。 */
export function faqCategoryFor(value: unknown): FaqCategory | null {
  if (isFaqCategory(value)) return value;
  if (isHelpdeskCategory(value)) return TICKET_TO_FAQ[value];
  return null;
}

export type HelpdeskQaCandidate = {
  id: string;
  category: FaqCategory;
  /** 该语言的问题。 */
  question: string;
  /** 该语言的已审核答案（Markdown 子集）；展示给学员时一字不改。 */
  answer: string;
  /** 检索得分，越大越相关（只用于排序与日志）。 */
  score: number;
};

export type HelpdeskQaSearch = {
  locale: string;
  /** 同类加权用的 FAQ 分类；没有则不加权。 */
  category: FaqCategory | null;
  text: string;
  limit: number;
};

/** 热门已发布 FAQ（v3 §1「你可能想问」：检索不到候选时的兜底）。 */
export type HelpdeskQaPopularSearch = {
  locale: string;
  /** 这一类排在前面；null 不分先后。 */
  category: FaqCategory | null;
  /** 不要这些 FAQ（刚给学员看过的）。 */
  excludeIds: string[];
  limit: number;
};

export const HELPDESK_QA_SOURCE = Symbol('HELPDESK_QA_SOURCE');

/** 已发布 FAQ 的只读来源（实现归 BackOffice）。 */
export interface HelpdeskQaSource {
  /** 候选检索（全文 + 关键词 + 中文双字 + 同类加权）；没有匹配返回空数组。 */
  findCandidates(search: HelpdeskQaSearch): Promise<HelpdeskQaCandidate[]>;
  /** 按 id 取一条已发布 FAQ 的该语言版本（score 为 0）；没有或已归档返回 null。 */
  findPublished(
    id: string,
    locale: string,
  ): Promise<HelpdeskQaCandidate | null>;
  /**
   * 热门（popular）的已发布 FAQ 的该语言版本（score 为 0）：category 那一类在前，再按更新时间倒序；
   * 不含 excludeIds。只用代码，不问模型。
   */
  findPopular(search: HelpdeskQaPopularSearch): Promise<HelpdeskQaCandidate[]>;
}
