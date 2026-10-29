import * as openccT2cn from 'opencc-js/t2cn';

import {
  EXCERPT_RULES,
  GUARD_LIMITS,
  type FaqBlock,
  type GuardedField,
  type GuardReason,
  type SuggestGuard,
} from '../../../contracts/helpdesk-qa';

/**
 * 守卫（helpdesk v5 Part B §2、Part D §4、Part H）：模型只写短句（寒暄 reply、答案的 opening / closing、
 * clarify 的 explanation），每一句展示前都过这里；任何一条不过 → 固定模板（reply / opening / closing），
 * 或不展示解释（explanation，Portal 显示固定文案 + 转人工卡）。纯函数，不调模型、不看学员数据。
 *
 * 短句（reply / opening / closing）依次检查：
 * missing（没写）→ markup（Markdown、代码、HTML、换行）→ email → link → digit（任何数字，含全角）→
 * too_long（按学员的文字：中文用 zh 上限，否则 en 上限）→ blocked_phrase（退款、免费、保证、承诺、优惠……
 * 以及「没找到 / couldn't find」这类）→ ai_filler（「当然！」「作为 AI」「希望对你有帮助」「Great question」……）→
 * script（与学员同一种文字：学员写了汉字，回复就得有汉字；学员写拉丁字母，回复里不能有汉字）。
 *
 * 解释（explanation）：每个数字串、链接、邮箱、**界面文字**、金额都必须出现在那条答案里（否则 ungrounded）；
 * **加粗** 只在接地后允许，展示前去掉星号（给学员的是纯文本）；承诺类禁用词只在答案里也有时允许
 * （解释退款 FAQ 免不了说「退款」），「没找到」类与 AI 套话一律不许；其余同短句（可分行写步骤）。
 *
 * 比较前统一：NFKC（全角数字 / 字母 → 半角）、小写、繁体 → 简体（OpenCC），所以 zh-TW 与 zh-CN 同一套词表。
 */

type Convert = (text: string) => string;
// opencc-js 1.4.2 的类型声明在 nodenext 下读不全（同 faqSearchText.ts），只声明用到的函数
const { Converter } = openccT2cn as unknown as {
  Converter: (options: { from: string; to: string }) => Convert;
};
let simplifyFn: Convert | null = null;
function simplify(text: string): string {
  if (!simplifyFn) {
    const fromHongKong = Converter({ from: 'hk', to: 'cn' });
    const fromTaiwan = Converter({ from: 'tw', to: 'cn' });
    simplifyFn = (value) => fromTaiwan(fromHongKong(value));
  }
  return simplifyFn(text);
}

/** 学员用的文字：zh（写了汉字，含中英混写）或 latin。 */
export type LearnerScript = 'zh' | 'latin';
/** 固定模板的语言：简体、繁体、英文。 */
export type TemplateVariant = 'zh-CN' | 'zh-TW' | 'en';

export type Learner = { script: LearnerScript; variant: TemplateVariant };

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * 学员的文字与模板语言：写了汉字 → zh（有繁体字 → zh-TW 模板）；只写拉丁字母 → latin；
 * 两样都没有（只有表情、标点）→ 看界面语言（zh-CN → 简体，其余英文）。
 */
export function learnerOf(text: string, locale: string): Learner {
  if (HAN.test(text))
    return {
      script: 'zh',
      variant: simplify(text) !== text ? 'zh-TW' : 'zh-CN',
    };
  if (LATIN.test(text)) return { script: 'latin', variant: 'en' };
  return locale === 'zh-CN'
    ? { script: 'zh', variant: 'zh-CN' }
    : { script: 'latin', variant: 'en' };
}

/** 比较用的统一写法（从不改给学员看的文字）。 */
export function normalizeForGuard(text: string): string {
  return simplify(text.normalize('NFKC').toLowerCase());
}

/** 字数：按 code point 数（一个汉字、一个字母、一个表情都算一个）。 */
export function textLength(text: string): number {
  return [...text].length;
}

/**
 * 承诺 / 事实类禁用词（Part B §2）：短句里一律不许；解释里只在答案本身也写了时允许。
 * 中文写简体（比较前繁体已转简体）；拉丁词按词首匹配（refund 也拦 refunds / refunded）。
 */
export const BLOCKED_PHRASES: readonly string[] = [
  '退款',
  '退费',
  '退钱',
  '免费',
  '保证',
  '担保',
  '承诺',
  '优惠',
  '折扣',
  '打折',
  '赔偿',
  '补偿',
  '价格',
  '包退',
  'refund',
  'free',
  'guarantee',
  'promise',
  'discount',
  'coupon',
  'voucher',
  'compensat',
  'price',
  'pricing',
];

/** 「没找到 / 搜过了」类（Part B：从不说找过或没找到）：任何字段都不许。 */
export const NOT_FOUND_PHRASES: readonly string[] = [
  '找不到',
  '没有找到',
  '没找到',
  '未找到',
  '找不着',
  '查不到',
  '没查到',
  '没有查到',
  '搜索',
  '搜了',
  '检索',
  "couldn't find",
  'could not find',
  "can't find",
  'cannot find',
  "didn't find",
  'did not find',
  'unable to find',
  'no results',
  'nothing found',
  'found nothing',
  'i searched',
  'i looked it up',
];

/** AI 套话（Part D §3）：任何字段都不许。 */
export const AI_FILLER: readonly string[] = [
  '当然!',
  '作为ai',
  '作为 ai',
  '作为一个ai',
  '作为一个 ai',
  '作为人工智能',
  'ai助手',
  'ai 助手',
  '语言模型',
  '希望对你有帮助',
  '希望对您有帮助',
  '希望能帮到你',
  '希望能帮到您',
  '希望这能帮到你',
  '希望以上',
  '我理解你的感受',
  '我理解您的感受',
  '好问题',
  '很好的问题',
  '很棒的问题',
  'great question',
  'good question',
  'excellent question',
  'i hope this helps',
  'hope this helps',
  'as an ai',
  'language model',
  'i understand your frustration',
  'i understand how you feel',
  'certainly!',
  'absolutely!',
];

const LATIN_WORD = /^[a-z]/;

/** 含禁用词却无害的固定说法（「feel free to ask」不是在说免费）。 */
const HARMLESS = [/feel free/g, /free to (?:ask|come|reach)/g];

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = HARMLESS.reduce((t, re) => t.replace(re, ' '), text);
  if (!LATIN_WORD.test(phrase)) return normalized.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}`).test(normalized);
}

function firstPhrase(
  normalized: string,
  phrases: readonly string[],
): string | null {
  return phrases.find((phrase) => containsPhrase(normalized, phrase)) ?? null;
}

const EMAIL = /[^\s@<>()[\]（）]+@[^\s@<>()[\]（）]+\.[a-z]{2,}/giu;
const URL =
  /(?:https?:\/\/|www\.)[^\s<>()[\]（）]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|co|uk|app|ai|edu|gov|me|info|hk|tw|dev)\b(?:\/[^\s<>()[\]（）]*)?/giu;
const DIGIT = /\p{N}/u;
const DIGIT_RUN = /\d+/g;
const CURRENCY =
  /[£$€¥]\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s?(?:元|块|英镑|美元|欧元|港币|pounds?\b|dollars?\b|euros?\b|gbp\b|usd\b|eur\b|cny\b|rmb\b|hkd\b)/giu;
const BOLD = /\*\*([^*\n]+?)\*\*/g;
const HTML_TAG = /<\/?[a-z][^>]*>/i;
/** 短句里任何 Markdown / 代码记号或换行都算 markup。 */
const SHORT_MARKUP = /[`*_#|[\]{}\n\r]|~~|<\/?[a-z][^>]*>/i;
/** 解释：可以分行写步骤（「1. 」「- 」），加粗另算；其余记号都算 markup。 */
const EXPLANATION_MARKUP = /[`_#|[\]{}*]|~~|^\s*>|<\/?[a-z][^>]*>/im;
const TRAILING = /[.,;:!?。，；：！？、)）'"]+$/u;

export type GuardCheck =
  { ok: true; text: string } | { ok: false; reason: GuardReason };

const fail = (reason: GuardReason): GuardCheck => ({ ok: false, reason });

function limitOf(field: GuardedField, learner: Learner): number {
  const limits = GUARD_LIMITS[field];
  return learner.script === 'zh' ? limits.zh : limits.en;
}

function scriptFits(text: string, learner: Learner): boolean {
  return learner.script === 'zh' ? HAN.test(text) : !HAN.test(text);
}

/** 短句（寒暄 reply、答案的 opening / closing）的守卫。 */
export function guardShortText(
  field: 'reply' | 'opening' | 'closing',
  raw: unknown,
  learner: Learner,
): GuardCheck {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('missing');
  const text = raw.trim();
  if (SHORT_MARKUP.test(text)) return fail('markup');
  const normalized = normalizeForGuard(text);
  if (new RegExp(EMAIL.source, 'iu').test(normalized)) return fail('email');
  if (new RegExp(URL.source, 'iu').test(normalized)) return fail('link');
  if (DIGIT.test(normalized)) return fail('digit');
  if (textLength(text) > limitOf(field, learner)) return fail('too_long');
  if (
    firstPhrase(normalized, BLOCKED_PHRASES) ||
    firstPhrase(normalized, NOT_FOUND_PHRASES)
  )
    return fail('blocked_phrase');
  if (firstPhrase(normalized, AI_FILLER)) return fail('ai_filler');
  if (!scriptFits(text, learner)) return fail('script');
  return { ok: true, text };
}

const clean = (token: string) => token.replace(TRAILING, '');

/** 解释里没出现在答案里的第一个数字串 / 链接 / 邮箱 / 金额 / 界面文字（都没有 → null）。 */
export function ungroundedToken(
  explanation: string,
  answer: string,
): string | null {
  const said = normalizeForGuard(explanation);
  const source = normalizeForGuard(answer);
  const compact = (text: string) => text.replace(/\s+/g, '');
  const sourceCompact = compact(source);
  for (const label of explanation.matchAll(BOLD)) {
    const text = normalizeForGuard(label[1]).trim();
    if (!source.includes(text)) return label[1];
  }
  const emails = [...said.matchAll(EMAIL)].map((m) => clean(m[0]));
  for (const email of emails) if (!source.includes(email)) return email;
  let rest = said;
  for (const email of emails) rest = rest.split(email).join(' ');
  for (const url of rest.matchAll(URL)) {
    const link = clean(url[0]);
    if (!source.includes(link)) return link;
  }
  for (const amount of said.matchAll(CURRENCY))
    if (!sourceCompact.includes(compact(clean(amount[0])))) return amount[0];
  const runs = new Set(source.match(DIGIT_RUN) ?? []);
  for (const run of said.match(DIGIT_RUN) ?? []) if (!runs.has(run)) return run;
  // 其它数字（罗马数字、上标、带圈数字……）答案里没法逐个比：一律算没接地
  if (DIGIT.test(said.replace(/\d/g, ''))) return 'digit';
  return null;
}

/** clarify 的解释：接地 + 同一套词表；通过时返回去掉加粗星号的纯文本。 */
export function guardExplanation(
  raw: unknown,
  answer: string,
  learner: Learner,
): GuardCheck {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('missing');
  const text = raw.trim();
  const plain = text.replace(BOLD, '$1');
  if (EXPLANATION_MARKUP.test(plain) || HTML_TAG.test(text))
    return fail('markup');
  if (ungroundedToken(text, answer) !== null) return fail('ungrounded');
  if (textLength(plain) > limitOf('explanation', learner))
    return fail('too_long');
  const normalized = normalizeForGuard(plain);
  const source = normalizeForGuard(answer);
  const promise = BLOCKED_PHRASES.find(
    (phrase) =>
      containsPhrase(normalized, phrase) && !containsPhrase(source, phrase),
  );
  if (promise || firstPhrase(normalized, NOT_FOUND_PHRASES))
    return fail('blocked_phrase');
  if (firstPhrase(normalized, AI_FILLER)) return fail('ai_filler');
  if (!scriptFits(plain, learner)) return fail('script');
  return { ok: true, text: plain };
}

/** 寒暄的意图 → 模板组（Part B §2：hello 与「我有个问题」同一句；谢谢 / 再见一句；跑题一句）。 */
export type ReplyIntent = 'greeting' | 'farewell' | 'vague' | 'off_topic';

/**
 * 固定模板（Part B §2、Part H）：守卫不过、超时、模型没写时用；点 chip 时（不问模型）也用。
 * 每一条自己也必须过守卫（guard.spec.ts 锁定）。
 */
export const TEMPLATES = {
  reply: {
    greeting: {
      'zh-CN':
        '你好！遇到什么问题了？可以直接告诉我，或者看看下面这些常见情况。',
      'zh-TW':
        '你好！遇到什麼問題了？可以直接告訴我，或者看看下面這些常見情況。',
      en: "Hi! What can I help you with? Tell me what's going on, or have a look at the common questions below.",
    },
    farewell: {
      'zh-CN': '不客气！之后有问题随时来问我。',
      'zh-TW': '不客氣！之後有問題隨時來問我。',
      en: "You're welcome! Come back any time you have a question.",
    },
    off_topic: {
      'zh-CN':
        '这个我帮不上忙。关于 Learning Guide 的使用、课程或订阅，随时问我。',
      'zh-TW':
        '這個我幫不上忙。關於 Learning Guide 的使用、課程或訂閱，隨時問我。',
      en: "I can't help with that one. Ask me anything about using Learning Guide, your courses or your subscription.",
    },
  },
  opening: {
    'zh-CN': '好的，这个问题可以这样处理：',
    'zh-TW': '好的，這個問題可以這樣處理：',
    en: "Here's how to sort this out:",
  },
  closing: {
    'zh-CN': '还有不清楚的，接着问我就好。',
    'zh-TW': '還有不清楚的，接著問我就好。',
    en: "If anything's unclear, just ask.",
  },
} as const;

export function replyTemplate(
  intent: ReplyIntent,
  variant: TemplateVariant,
): string {
  const group = intent === 'vague' ? 'greeting' : intent;
  return TEMPLATES.reply[group][variant];
}

/** 守卫结果汇总（契约 SuggestGuard）：reason 是第一个回退字段的原因。 */
export function guardSummary(
  checks: { field: GuardedField; reason: GuardReason | null }[],
): SuggestGuard {
  const failed = checks.filter((c) => c.reason !== null);
  if (failed.length === 0)
    return { result: 'passed', reason: null, fallback: [] };
  return {
    result: 'fallback',
    reason: failed[0].reason,
    fallback: failed.map((c) => c.field),
  };
}

const BLOCK_ID = /^b([1-9]\d*)$/;

/**
 * 摘录（Part H）：模型给的 blocks 是不是所选答案块 id 的 1–3 个连续子集（顺序无所谓，按编号排）；
 * 答案短（≤ 3 块或 ≤ 200 字）、没给、不合法、或选了全部块 → []（= 整条答案，不显示「查看完整答案」）。
 */
export function chooseExcerpt(
  blocks: readonly FaqBlock[] | undefined,
  answer: string,
  picked: readonly string[] | undefined,
): string[] {
  if (!blocks || blocks.length <= EXCERPT_RULES.wholeAnswerMaxBlocks) return [];
  if (textLength(answer) <= EXCERPT_RULES.wholeAnswerMaxChars) return [];
  if (!picked || picked.length === 0) return [];
  const known = new Set(blocks.map((b) => b.id));
  const ids = [...new Set(picked)];
  if (ids.length > EXCERPT_RULES.maxBlocks) return [];
  if (!ids.every((id) => known.has(id) && BLOCK_ID.test(id))) return [];
  const numbers = ids
    .map((id) => Number((BLOCK_ID.exec(id) as RegExpExecArray)[1]))
    .sort((a, b) => a - b);
  if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1)) return [];
  if (numbers.length === blocks.length) return [];
  return numbers.map((n) => `b${n}`);
}
