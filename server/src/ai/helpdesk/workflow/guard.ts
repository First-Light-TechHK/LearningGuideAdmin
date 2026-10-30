import * as openccT2cn from 'opencc-js/t2cn';

import { GAP_LABEL_LIMITS } from '../../../contracts/helpdesk-flywheel';
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
 * 比较前统一：NFKC（全角数字 / 字母 → 半角）、小写、繁体 → 简体（OpenCC），所以 zh-TW 与 zh-CN 同一套词表；
 * 去掉隐形字符（零宽、软连字符、方向控制）与附加符号、汉字之间的空白、弯引号 → 直引号，
 * 免得「免\u200b费」「re\u0301fund」「免 费」绕过词表。原文里有隐形字符（emoji 的 ZWJ 连接除外）本身就算 markup。
 *
 * 数字不只是阿拉伯数字：用文字写的时长 / 金额（「三天」「一两个工作日」「几分钟」「two working days」
 * 「half an hour」「a few minutes」）同样算 digit；解释里它们必须原样出现在答案里。序数（第一步、first）不算。
 * 承诺 / 已办理类说法（「一定」「马上」「已为你」「I've」「I will make sure」「definitely」）同禁用词。
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
  const plain = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1')
    .toLowerCase();
  return simplify(plain);
}

/** 隐形的格式字符（Unicode Cf：零宽空格 / 连接符、软连字符、方向控制……）。 */
const INVISIBLE = /\p{Cf}/gu;
/** emoji 序列里的 ZWJ（👨‍👩‍👧）不算藏字符。 */
const EMOJI_ZWJ =
  /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;

/** 原文里藏了隐形字符（emoji 的 ZWJ 除外）。 */
export function hasHiddenCharacters(text: string): boolean {
  return new RegExp(INVISIBLE.source, 'u').test(text.replace(EMOJI_ZWJ, '$1'));
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

/**
 * 承诺 / 「已经帮你办了」类说法（模型不能替系统承诺或声称做过什么）：同 BLOCKED_PHRASES 处理
 * （短句一律不许；解释里只在答案本身也这么写时允许）。
 */
export const PROMISE_PHRASES: readonly string[] = [
  '一定',
  '肯定会',
  '马上',
  '立刻',
  '立即',
  '已为你',
  '已为您',
  '已经为你',
  '已经为您',
  '已帮你',
  '已帮您',
  '已经帮你',
  '已经帮您',
  '已经替你',
  '我已经',
  '我已',
  '我会确保',
  '帮你取消',
  '帮您取消',
  '帮你开通',
  '帮您开通',
  '帮你解决',
  '帮您解决',
  'i have',
  "i've",
  "i'll make sure",
  'i will make sure',
  "we'll make sure",
  'we will make sure',
  'definitely',
  'right away',
  'straight away',
  'immediately',
  'for sure',
  'rest assured',
  'i can confirm',
];

const CLAIM_PHRASES: readonly string[] = [
  ...BLOCKED_PHRASES,
  ...PROMISE_PHRASES,
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
  '搜了',
  '我搜',
  '我查了',
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

/**
 * 界面上的词（「搜索框」「检索」）：短句里同 NOT_FOUND_PHRASES 一律不许；解释里只在答案本身也写了时允许
 * （答案教学员用搜索框，解释免不了说「搜索」）。
 */
export const UI_SEARCH_WORDS: readonly string[] = ['搜索', '检索'];

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
/** 拉丁词按整词匹配，允许常见词尾（refund → refunds / refunded；free 不拦 freeze / freely；price 不拦 priceless）。 */
const LATIN_SUFFIX = '(?:s|es|d|ed|ing|e|ion|ions)?';

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = HARMLESS.reduce((t, re) => t.replace(re, ' '), text);
  if (!LATIN_WORD.test(phrase)) return normalized.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}${LATIN_SUFFIX}(?![a-z])`).test(
    normalized,
  );
}

function firstPhrase(
  normalized: string,
  phrases: readonly string[],
): string | null {
  return phrases.find((phrase) => containsPhrase(normalized, phrase)) ?? null;
}

const EMAIL = /[^\s@<>()[\]（）]+@[^\s@<>()[\]（）]+\.[a-z]{2,}/giu;
/** 链接：带协议或 www.，或任何「点 + 两个以上字母」结尾的主机名（不靠后缀白名单：.xyz、.online 也算）。 */
const URL =
  /(?:https?:\/\/|www\.)[^\s<>()[\]（）]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/[^\s<>()[\]（）]*)?/giu;
/**
 * 用文字写的数量（时长、金额）：中文数字（含「两」「半」「几」）+ 时间 / 钱的单位，前面不是「第」；
 * 英文数词（zero…ninety、hundred、dozen、half、a few、a couple of、several）+ 单位。序数不算。
 */
const ZH_NUMBER =
  /(?<!第)[零〇一二两三四五六七八九十百千万半几]+(?:\s*(?:到|至|或|-|–|~)\s*[零〇一二两三四五六七八九十百千万半几]+)?\s*(?:多|来)?\s*个?\s*(?:半\s*)?(?:工作日|天|日|周|星期|礼拜|月|年|分钟|小时|钟头|钟|秒|刻钟|元|块钱|英镑|镑|美元|欧元|港币|毛钱)/gu;
const EN_NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|half an?|half|a few|few|a couple of|couple of|several)';
const EN_NUMBER = new RegExp(
  `\\b${EN_NUMBER_WORD}(?:[\\s-]+(?:to|or|and|-)?[\\s-]*${EN_NUMBER_WORD})*[\\s-]+(?:more\\s+)?(?:(?:working|business|calendar)\\s+)?(?:seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|fortnights?|months?|years?|pounds?|quid|dollars?|euros?|pence|cents?)\\b`,
  'gu',
);

/** 用文字写的数量（normalizeForGuard 之后的文本里找）。 */
export function numberWords(normalized: string): string[] {
  return [
    ...[...normalized.matchAll(ZH_NUMBER)].map((m) => m[0]),
    ...[...normalized.matchAll(EN_NUMBER)].map((m) => m[0]),
  ];
}
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
  if (SHORT_MARKUP.test(text) || hasHiddenCharacters(text))
    return fail('markup');
  const normalized = normalizeForGuard(text);
  if (new RegExp(EMAIL.source, 'iu').test(normalized)) return fail('email');
  if (new RegExp(URL.source, 'iu').test(normalized)) return fail('link');
  if (DIGIT.test(normalized) || numberWords(normalized).length > 0)
    return fail('digit');
  if (textLength(text) > limitOf(field, learner)) return fail('too_long');
  if (
    firstPhrase(normalized, CLAIM_PHRASES) ||
    firstPhrase(normalized, NOT_FOUND_PHRASES) ||
    firstPhrase(normalized, UI_SEARCH_WORDS)
  )
    return fail('blocked_phrase');
  if (firstPhrase(normalized, AI_FILLER)) return fail('ai_filler');
  if (!scriptFits(text, learner)) return fail('script');
  return { ok: true, text };
}

const clean = (token: string) => token.replace(TRAILING, '');
/** 链接比较用：去掉协议、www. 与末尾斜杠。 */
const linkKey = (link: string) =>
  clean(link)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');

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
  // 邮箱、链接按整个记号比（不是子串：learningguide.co 不因答案里有 learningguide.com 而算接地）
  const emailsOf = (text: string) =>
    [...text.matchAll(EMAIL)].map((m) => clean(m[0]).replace(/^mailto:/, ''));
  const sourceEmails = new Set(emailsOf(source));
  const emails = emailsOf(said);
  for (const email of emails) if (!sourceEmails.has(email)) return email;
  const sourceLinks = new Set<string>();
  for (const url of source.matchAll(URL)) {
    const key = linkKey(url[0]);
    sourceLinks.add(key);
    sourceLinks.add(key.split('/')[0]); // 只说主机名也算（答案里有这个网站）
  }
  let rest = said;
  for (const email of emails) rest = rest.split(email).join(' ');
  for (const url of rest.matchAll(URL)) {
    const link = clean(url[0]);
    if (!sourceLinks.has(linkKey(link))) return link;
  }
  for (const amount of said.matchAll(CURRENCY))
    if (!sourceCompact.includes(compact(clean(amount[0])))) return amount[0];
  const runs = new Set(source.match(DIGIT_RUN) ?? []);
  for (const run of said.match(DIGIT_RUN) ?? []) if (!runs.has(run)) return run;
  for (const words of numberWords(said))
    if (!sourceCompact.includes(compact(words))) return words;
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
  if (
    EXPLANATION_MARKUP.test(plain) ||
    HTML_TAG.test(text) ||
    hasHiddenCharacters(text)
  )
    return fail('markup');
  if (ungroundedToken(text, answer) !== null) return fail('ungrounded');
  if (textLength(plain) > limitOf('explanation', learner))
    return fail('too_long');
  const normalized = normalizeForGuard(plain);
  const source = normalizeForGuard(answer);
  const promise = [...CLAIM_PHRASES, ...UI_SEARCH_WORDS].find(
    (phrase) =>
      containsPhrase(normalized, phrase) && !containsPhrase(source, phrase),
  );
  if (promise || firstPhrase(normalized, NOT_FOUND_PHRASES))
    return fail('blocked_phrase');
  if (firstPhrase(normalized, AI_FILLER)) return fail('ai_filler');
  if (!scriptFits(plain, learner)) return fail('script');
  return { ok: true, text: plain };
}

/**
 * 数据飞轮的标签（v5 Part G3 第 3 步）：模型给一组未解决的问题起的话题（topic）与提议的学员问题
 * （question）。不展示给学员（员工审），但同样只信代码：没写 / 记号或占位符 / 邮箱 / 链接 → 拒；
 * 数字与用文字写的数量必须在学员的例句里出现过（模型不许编事实，ungrounded）；按学员的文字限长
 * （GAP_LABEL_LIMITS）；AI 套话、与学员不同的文字 → 拒。退款、免费这类词允许：学员就是这么问的。
 */
export function guardGapLabel(
  field: 'topic' | 'question',
  raw: unknown,
  learner: Learner,
  examples: readonly string[],
): GuardCheck {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('missing');
  const text = raw.trim();
  if (SHORT_MARKUP.test(text) || /[<>]/.test(text) || hasHiddenCharacters(text))
    return fail('markup');
  const normalized = normalizeForGuard(text);
  if (new RegExp(EMAIL.source, 'iu').test(normalized)) return fail('email');
  if (new RegExp(URL.source, 'iu').test(normalized)) return fail('link');
  const source = normalizeForGuard(examples.join('\n'));
  const compact = (value: string) => value.replace(/\s+/g, '');
  const runs = new Set(source.match(DIGIT_RUN) ?? []);
  if ((normalized.match(DIGIT_RUN) ?? []).some((run) => !runs.has(run)))
    return fail('ungrounded');
  if (
    numberWords(normalized).some(
      (words) => !compact(source).includes(compact(words)),
    )
  )
    return fail('ungrounded');
  if (DIGIT.test(normalized.replace(/\d/g, ''))) return fail('ungrounded');
  const limits = GAP_LABEL_LIMITS[field];
  if (textLength(text) > (learner.script === 'zh' ? limits.zh : limits.en))
    return fail('too_long');
  if (firstPhrase(normalized, AI_FILLER)) return fail('ai_filler');
  if (!scriptFits(text, learner)) return fail('script');
  return { ok: true, text };
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

/**
 * 答案卡片前后的固定短句：模型只选语气（tone），文字由这里给。
 * steps = 问怎么做；problem = 报告出问题或着急；explain = 问是什么、为什么、能不能、什么时候。
 * 模型选 none 或没选 → TEMPLATES.opening / closing。每一条都必须过守卫（guard.spec.ts 锁定）。
 */
export const ANSWER_TONES = ['steps', 'problem', 'explain'] as const;
export type AnswerTone = (typeof ANSWER_TONES)[number];

const ASK_AGAIN = {
  'zh-CN': '有不清楚的地方再问我。',
  'zh-TW': '有不清楚的地方再問我。',
  en: 'Ask me if anything is unclear.',
} as const;

export const ANSWER_LINES: Record<
  AnswerTone,
  Record<'opening' | 'closing', Record<TemplateVariant, string>>
> = {
  steps: {
    opening: {
      'zh-CN': '可以按下面的步骤来：',
      'zh-TW': '可以按下面的步驟來：',
      en: 'Here are the steps:',
    },
    closing: ASK_AGAIN,
  },
  problem: {
    opening: {
      'zh-CN': '别担心，先看看下面的说明：',
      'zh-TW': '別擔心，先看看下面的說明：',
      en: "Don't worry, have a look at this first:",
    },
    closing: {
      'zh-CN': '按上面试一下，还不行就告诉我。',
      'zh-TW': '照上面試一下，還不行就告訴我。',
      en: "Try this first, and tell me if it still doesn't work.",
    },
  },
  explain: {
    opening: {
      'zh-CN': '帮助中心的说明是这样的：',
      'zh-TW': '幫助中心的說明是這樣的：',
      en: "Here's what the help centre says:",
    },
    closing: ASK_AGAIN,
  },
};

export function isAnswerTone(value: unknown): value is AnswerTone {
  return (ANSWER_TONES as readonly unknown[]).includes(value);
}

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
