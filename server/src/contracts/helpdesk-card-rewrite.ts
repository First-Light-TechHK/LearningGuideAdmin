/**
 * BackOffice「AI 按指令改卡」（owner 2026-10-31：卡片编辑像 Claude Artifact，员工说怎么改，AI 改好给员工看）
 * 的交接契约：模型调用在 Agent（src/ai/helpdesk/card-rewriter.ts），BackOffice 只经这里的 CardRewriter 用它，
 * 由 app.module.ts 组装（没有 key / 测试里 = 不问模型）。
 *
 * 只用 DeepSeek（和 Helpdesk 回答同一个模型）；从不保存——返回一份草稿，员工看过、再走现有的保存接口。
 * 卡的文字和员工的指令都是员工写的，不含用户数据。
 */
export const HELPDESK_CARD_REWRITER = Symbol('HELPDESK_CARD_REWRITER');

export const CARD_TEXT_FIELDS = [
  'questionZh',
  'answerZh',
  'questionEn',
  'answerEn',
] as const;
export type CardTextField = (typeof CARD_TEXT_FIELDS)[number];

export type CardText = Record<CardTextField, string> & {
  category: string | null;
};

export type CardRewriteInput =
  | { mode: 'card'; card: CardText; instruction: string; lang: 'zh' | 'en' }
  | {
      mode: 'selection';
      card: CardText;
      instruction: string;
      lang: 'zh' | 'en';
      /** 只改这一段：字段 + 字符位置（UTF-16，和输入框的 selectionStart / selectionEnd 一致）。 */
      selection: { field: CardTextField; start: number; end: number };
    };

export type CardRewriteSkip = 'disabled' | 'timeout' | 'error' | 'no_call';

export type CardRewriteResult =
  | {
      ok: true;
      /** card：模型改了的字段的全文（没改的不给）；selection：只有 selection = 那一段的新文字。 */
      texts: Partial<Record<CardTextField | 'selection', string>>;
      /** card 模式下模型选的分类；undefined = 不改。 */
      category?: string;
      model: string;
      costUsd: number | null;
    }
  | { ok: false; reason: CardRewriteSkip; costUsd: number | null };

export interface CardRewriter {
  /** 一次模型调用（不重试、有期限）；任何问题都返回 ok:false，从不抛错。 */
  rewrite(input: CardRewriteInput): Promise<CardRewriteResult>;
}

/** 不问模型（测试、没有 key）：一律 disabled。 */
export const noCardRewriter: CardRewriter = {
  rewrite: () =>
    Promise.resolve({ ok: false, reason: 'disabled', costUsd: null }),
};
