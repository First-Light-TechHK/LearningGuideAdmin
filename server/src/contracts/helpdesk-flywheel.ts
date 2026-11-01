import type { FaqCategory } from './helpdesk-qa';

/**
 * 数据飞轮的跨域契约（v5 Part G3 第 3 步）：缺口挖掘归 BackOffice，给一组未解决的问题起话题、
 * 提一个学员口吻的问题要问模型，模型的调用归 Agent（pi 工作流、守卫、key 与预算）。两边互不 import
 * 实现，经这里的 GapLabeller 交接，由 app.module.ts 组装（没有 key / 测试里 = 不问模型，代码兜底）。
 *
 * 模型只做两件事：给这一组起一个话题、提**一个**学员会怎么问的问题（外加一个 FAQ 分类的枚举）。
 * 它从不写答案、步骤、数字或任何事实；答案由员工写（可选的草稿只来自已解决工单里人写的回复）。
 * 输入只有 Portal 脱敏过的例句（至多 5 句），没有任何学员数据。
 */
export const HELPDESK_GAP_LABELLER = Symbol('HELPDESK_GAP_LABELLER');

export type GapLabelLocale = 'en-GB' | 'zh-CN' | 'zh-TW';

export type GapLabelInput = {
  /** 这一组的主要语言（例句里最多的那种）。 */
  locale: GapLabelLocale;
  /** Portal 脱敏过的学员原话，1–5 句（不可信输入）。 */
  examples: readonly string[];
};

/** 过了守卫的标签：话题（短）、一个学员口吻的问题、FAQ 分类（枚举，可以没有）。 */
export type GapLabel = {
  topic: string;
  question: string;
  category: FaqCategory | null;
};

/** 话题与问题的长度上限（按 code point；中文用 zh，否则 en）。 */
export const GAP_LABEL_LIMITS = {
  topic: { zh: 20, en: 60 },
  question: { zh: 60, en: 160 },
  examplesMax: 5,
} as const;

/** 这一次为什么没有模型标签（只记原因码，不记文字）。 */
export type GapLabelSkip =
  'disabled' | 'budget' | 'no_call' | 'error' | 'timeout' | 'guard';

export type GapLabelResult =
  | { ok: true; label: GapLabel; costUsd: number | null }
  | { ok: false; reason: GapLabelSkip; costUsd: number | null };

export interface GapLabeller {
  /** 一次小的模型调用（不重试、有期限）；任何问题都返回 ok:false（挖掘用代码兜底），从不抛错。 */
  label(input: GapLabelInput): Promise<GapLabelResult>;
}

/** 不问模型（测试、没有 key）：一律 disabled。 */
export const noGapLabeller: GapLabeller = {
  label: () =>
    Promise.resolve({ ok: false, reason: 'disabled', costUsd: null }),
};
