import {
  CARD_TEXT_FIELDS,
  type CardRewriteInput,
  type CardRewriter,
  type CardText,
  type CardTextField,
} from '../../../../contracts/helpdesk-card-rewrite';
import { HelpdeskError } from '../portalHelpdeskClient';
import { FAQ_CATEGORIES } from '../../../../contracts/helpdesk-qa';
import { FAQ_LIMITS, type FaqActor } from './faqContracts';

/**
 * 「AI 按指令改卡」（像 Claude Artifact：员工说怎么改，AI 改好，员工看过再保存）：
 * POST /api/helpdesk/faqs/rewrite { questionZh, answerZh, questionEn, answerEn, category, instruction, lang, selection? }
 * → { draft, changed, model, costUsd, warnings }
 * - 只用 DeepSeek（CardRewriter，Agent 里组装）；不保存、不改库，版本由前端在本地留着，「保存并批准」走现有接口；
 * - 代码兜底：控制字符去掉、长度不超过卡的上限、改过的字段不能变空、中文字段要有中文、英文字段不能有中文；
 *   不合格的字段不采用（保留原文），在 warnings 里说明；
 * - 改后的文字里出现原卡和指令里都没有的数字、链接、邮箱 → warnings 提示员工核实（不拦，员工决定）；
 * - 每位员工每分钟至多 REWRITE_LIMITS.perMinute 次（进程内）。
 */
export const REWRITE_LIMITS = {
  instructionMax: 500,
  perMinute: 20,
} as const;

const FIELD_MAX: Record<CardTextField, number> = {
  questionZh: FAQ_LIMITS.questionMax,
  questionEn: FAQ_LIMITS.questionMax,
  answerZh: FAQ_LIMITS.answerMax,
  answerEn: FAQ_LIMITS.answerMax,
};

export type RewriteWarning =
  | { field: CardTextField; kind: 'number' | 'link' | 'email'; text: string }
  | {
      field: CardTextField;
      kind: 'dropped';
      reason: 'empty' | 'too_long' | 'language';
    };

export type RewriteResponse = {
  draft: CardText;
  changed: (CardTextField | 'category')[];
  model: string;
  costUsd: number | null;
  warnings: RewriteWarning[];
};

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const HAN = /\p{Script=Han}/u;

function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 请求体 → 模型的输入（不合规 400）。 */
export function rewriteInput(raw: unknown): CardRewriteInput {
  const body = record(raw);
  const card = {} as CardText;
  for (const field of CARD_TEXT_FIELDS) {
    const value = body[field] ?? '';
    if (typeof value !== 'string') throw invalid(`${field} must be text`);
    const text = clean(value);
    if (text.length > FIELD_MAX[field])
      throw invalid(`${field} must be at most ${FIELD_MAX[field]} characters`);
    card[field] = text;
  }
  const category = body.category ?? null;
  if (
    category !== null &&
    !(
      typeof category === 'string' &&
      (FAQ_CATEGORIES as readonly string[]).includes(category)
    )
  )
    throw invalid('Unknown category');
  card.category = category;
  if (typeof body.instruction !== 'string')
    throw invalid('instruction is required');
  const instruction = clean(body.instruction).trim();
  if (instruction === '') throw invalid('instruction is required');
  if ([...instruction].length > REWRITE_LIMITS.instructionMax)
    throw invalid(
      `instruction must be at most ${REWRITE_LIMITS.instructionMax} characters`,
    );
  const lang = body.lang ?? 'zh';
  if (lang !== 'zh' && lang !== 'en') throw invalid('lang must be zh or en');
  if (body.selection === undefined || body.selection === null)
    return { mode: 'card', card, instruction, lang };
  const selection = record(body.selection);
  const field = selection.field;
  if (
    typeof field !== 'string' ||
    !(CARD_TEXT_FIELDS as readonly string[]).includes(field)
  )
    throw invalid('selection.field must be a card text field');
  const { start, end } = selection;
  const text = card[field as CardTextField];
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > text.length ||
    start >= end ||
    text.slice(start, end).trim() === ''
  )
    throw invalid('selection must mark some text inside the field');
  return {
    mode: 'selection',
    card,
    instruction,
    lang,
    selection: { field: field as CardTextField, start, end },
  };
}

const NUMBER = /\d+(?:[.,:/]\d+)*/g;
const LINK = /(?:https?:\/\/|www\.)[^\s<>()（）「」]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 改后的文字里有、原卡和指令里都没有的数字、链接、邮箱。 */
export function newFacts(
  field: CardTextField,
  after: string,
  known: string,
): RewriteWarning[] {
  const out: RewriteWarning[] = [];
  const seen = new Set<string>();
  const emails = after.match(EMAIL) ?? [];
  // 链接末尾的句号、逗号、括号是句子的，不是链接的
  const links = (after.match(LINK) ?? []).map((link) =>
    link.replace(/[.,;:!?。，；：！？]+$/u, ''),
  );
  for (const [kind, list] of [
    ['email', emails],
    ['link', links],
  ] as const)
    for (const text of list)
      if (!known.includes(text) && !seen.has(text)) {
        seen.add(text);
        out.push({ field, kind, text });
      }
  // 数字：不算出现在新链接、新邮箱里的
  let rest = after;
  for (const text of [...emails, ...links]) rest = rest.split(text).join(' ');
  for (const text of rest.match(NUMBER) ?? [])
    if (!known.includes(text) && !seen.has(text)) {
      seen.add(text);
      out.push({ field, kind: 'number', text });
    }
  return out;
}

/** 模型的结果 → 草稿：拼回一段、过代码兜底、算 changed 与 warnings。 */
export function buildDraft(
  input: CardRewriteInput,
  result: {
    texts: Partial<Record<CardTextField | 'selection', string>>;
    category?: string;
  },
): {
  draft: CardText;
  changed: RewriteResponse['changed'];
  warnings: RewriteWarning[];
} {
  const draft: CardText = { ...input.card };
  const proposed: Partial<Record<CardTextField, string>> = {};
  if (input.mode === 'selection') {
    const { field, start, end } = input.selection;
    const replacement = result.texts.selection;
    if (typeof replacement === 'string') {
      const original = input.card[field];
      proposed[field] =
        original.slice(0, start) +
        clean(replacement).replace(/[⟦⟧]/g, '') +
        original.slice(end);
    }
  } else {
    for (const field of CARD_TEXT_FIELDS) {
      const text = result.texts[field];
      if (typeof text === 'string') proposed[field] = clean(text).trim();
    }
  }
  const known = [
    ...CARD_TEXT_FIELDS.map((f) => input.card[f]),
    input.instruction,
  ].join('\n');
  const warnings: RewriteWarning[] = [];
  for (const field of CARD_TEXT_FIELDS) {
    const after = proposed[field];
    if (after === undefined || after === input.card[field]) continue;
    const zh = field.endsWith('Zh');
    const reason =
      after.trim() === '' && input.card[field].trim() !== ''
        ? 'empty'
        : after.length > FIELD_MAX[field]
          ? 'too_long'
          : (zh && after.trim() !== '' && !HAN.test(after)) ||
              (!zh && HAN.test(after))
            ? 'language'
            : null;
    if (reason) {
      warnings.push({ field, kind: 'dropped', reason });
      continue;
    }
    draft[field] = after;
    warnings.push(...newFacts(field, after, known));
  }
  if (
    input.mode === 'card' &&
    result.category &&
    (FAQ_CATEGORIES as readonly string[]).includes(result.category)
  )
    draft.category = result.category;
  const changed: RewriteResponse['changed'] = CARD_TEXT_FIELDS.filter(
    (field) => draft[field] !== input.card[field],
  );
  if (draft.category !== input.card.category) changed.push('category');
  return { draft, changed, warnings };
}

export type FaqRewriteServiceDeps = {
  rewriter: CardRewriter;
  now?: () => number;
};

export function createFaqRewriteService(deps: FaqRewriteServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const recent = new Map<string, number[]>();

  function allow(actor: FaqActor): boolean {
    const key = actor.employeeId ?? 'unknown';
    const since = now() - 60_000;
    const kept = (recent.get(key) ?? []).filter((t) => t > since);
    if (kept.length >= REWRITE_LIMITS.perMinute) {
      recent.set(key, kept);
      return false;
    }
    kept.push(now());
    recent.set(key, kept);
    return true;
  }

  return {
    async rewrite(actor: FaqActor, raw: unknown): Promise<RewriteResponse> {
      const input = rewriteInput(raw);
      if (!allow(actor))
        throw new HelpdeskError(
          429,
          'REWRITE_RATE_LIMITED',
          `At most ${REWRITE_LIMITS.perMinute} AI edits a minute. Try again shortly.`,
        );
      const result = await deps.rewriter.rewrite(input);
      if (!result.ok) {
        if (result.reason === 'disabled')
          throw new HelpdeskError(
            503,
            'REWRITE_UNAVAILABLE',
            'AI editing is not configured.',
          );
        if (result.reason === 'timeout')
          throw new HelpdeskError(
            504,
            'REWRITE_TIMEOUT',
            'The AI took too long. Try again.',
          );
        throw new HelpdeskError(
          502,
          'REWRITE_FAILED',
          'The AI could not edit this card. Try again or rephrase.',
        );
      }
      const { draft, changed, warnings } = buildDraft(input, result);
      return {
        draft,
        changed,
        model: result.model,
        costUsd: result.costUsd,
        warnings,
      };
    },
  };
}

export type FaqRewriteService = ReturnType<typeof createFaqRewriteService>;
