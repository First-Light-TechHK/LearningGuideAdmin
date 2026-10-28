/**
 * Helpdesk Common Questions 的跨域契约（Figma addendum §A / §C）。
 *
 * - 问答库（helpdesk_questions）归 BackOffice（admin 角色）写；
 * - 推荐（helpdesk_suggestions）归 Agent（agent 角色）写；
 * 两边互不 import 实现（eslint no-restricted-imports），只经这里的接口相互读：
 * Agent 经 HelpdeskQaSource 取已发布问题做候选；BackOffice 经 HelpdeskSuggestionStats
 * 读每题的 shown / solved / declined。具体实现由 app.module.ts 组装。
 * 只做加法：新增字段必须可选。
 */
export const HELPDESK_LOCALES = ['en-GB', 'zh-CN'] as const;
export type HelpdeskLocale = (typeof HELPDESK_LOCALES)[number];

/** Enquiry Type（Figma 1216:6）：工单 category 与问答 category 共用。 */
export const HELPDESK_CATEGORIES = [
  'technical_support',
  'course_content',
  'payments_subscriptions',
  'other',
] as const;
export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

export function isHelpdeskLocale(value: unknown): value is HelpdeskLocale {
  return (HELPDESK_LOCALES as readonly unknown[]).includes(value);
}

export function isHelpdeskCategory(value: unknown): value is HelpdeskCategory {
  return (HELPDESK_CATEGORIES as readonly unknown[]).includes(value);
}

export type HelpdeskQaCandidate = {
  id: string;
  category: HelpdeskCategory;
  question: string;
  /** 已审核的原答案；展示给学员时一字不改。 */
  answer: string;
  /** 检索得分，越大越相关（只用于排序与日志）。 */
  score: number;
};

export type HelpdeskQaSearch = {
  locale: string;
  category: string;
  text: string;
  limit: number;
};

export const HELPDESK_QA_SOURCE = Symbol('HELPDESK_QA_SOURCE');

/** 已发布问题的候选检索（全文 + 关键词 + 同类加权）；没有匹配返回空数组。 */
export interface HelpdeskQaSource {
  findCandidates(search: HelpdeskQaSearch): Promise<HelpdeskQaCandidate[]>;
}

export type HelpdeskQuestionStats = {
  shown: number;
  solved: number;
  declined: number;
};

export const HELPDESK_SUGGESTION_STATS = Symbol('HELPDESK_SUGGESTION_STATS');

/** 每个问题被推荐的次数与学员反馈；没有记录的问题不出现在结果里。 */
export interface HelpdeskSuggestionStats {
  statsFor(questionIds: string[]): Promise<Map<string, HelpdeskQuestionStats>>;
}
