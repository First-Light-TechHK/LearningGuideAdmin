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

// ---------------------------------------------------------------------------
// Helpdesk v5（契约 fixture v6，2026-10-30）：学员情境信号、FAQ 问题树的发布快照、推荐的
// 新字段。全部是增量：旧的 Portal 不发 context、不读新字段；旧的 Admin 不认 context。
// 规范：lg-helpdesk/helpdesk-v5-context-chips-and-smalltalk.md（Part A/B/D/H）与
// helpdesk-v5-faq-graph-design.md（§1、§2.2、§4、§6）。
// ---------------------------------------------------------------------------

/**
 * Part A：学员情境信号。Portal 只用代码、只读 Portal 自己的数据算出来（每个只是真 / 假，不存值），
 * 从不经过模型；Admin 与模型都收不到学员的信号，只有 FAQ 上打的标签（见 FAQ_SIGNALS）。
 * 顺序 = 规范 Part A §1 的表。
 */
export const SITUATION_SIGNALS = [
  'trial_ending',
  'payment_failed',
  'payment_pending',
  'recent_purchase',
  'subscription_cancelled',
  'subscription_expired',
  'email_unverified',
  'open_ticket_waiting',
  'from_order',
] as const;
export type SituationSignal = (typeof SITUATION_SIGNALS)[number];

/**
 * FAQ 可打的信号标签（helpdesk_faqs.signals），顺序就是 Portal 选「你可能遇到的问题」时的优先级
 * （Part A §3）。open_ticket_waiting 不是 FAQ（Portal 显示固定的工单卡片），不能打在 FAQ 上。
 */
export const FAQ_SIGNALS = [
  'payment_failed',
  'payment_pending',
  'recent_purchase',
  'trial_ending',
  'subscription_expired',
  'subscription_cancelled',
  'email_unverified',
  'from_order',
] as const satisfies readonly SituationSignal[];
export type FaqSignal = (typeof FAQ_SIGNALS)[number];

export function isSituationSignal(value: unknown): value is SituationSignal {
  return (SITUATION_SIGNALS as readonly unknown[]).includes(value);
}

export function isFaqSignal(value: unknown): value is FaqSignal {
  return (FAQ_SIGNALS as readonly unknown[]).includes(value);
}

/** 问题树（DAG）的节点类型：answer = FAQ 卡片；choice = 一句提问 + 2–4 个选项（不陈述事实）。 */
export const FAQ_NODE_TYPES = ['answer', 'choice'] as const;
export type FaqNodeType = (typeof FAQ_NODE_TYPES)[number];

/** 边：follow_up = 答案下的追问 chip；option = choice 节点的 A/B/C/D 按钮。 */
export const FAQ_EDGE_KINDS = ['follow_up', 'option'] as const;
export type FaqEdgeKind = (typeof FAQ_EDGE_KINDS)[number];

/** 发布版本的状态（helpdesk_faq_releases.status；至多一行 published）。 */
export const FAQ_RELEASE_STATUSES = [
  'draft',
  'evaluating',
  'published',
  'rejected',
  'superseded',
] as const;
export type FaqReleaseStatus = (typeof FAQ_RELEASE_STATUSES)[number];

/**
 * 答案块（Part H）：发布时由代码把每条答案切成块（faqBlocks.ts splitAnswerBlocks：每段一块、
 * 每组编号步骤一块、每个列表一块），id 按顺序 b1..bn，同一快照里稳定。text 是该块的 Markdown 原文，
 * 单独渲染与它在整条答案里渲染完全相同。Portal 按 id 原样渲染，不切、不改。
 */
export type FaqBlock = { id: string; text: string };

/** 快照里的一个节点，某一种语言（与 PublicFaq 一样按 ?locale= 挑好字段）。 */
export type FaqNode = {
  id: string;
  /** 稳定的 slug，改文字也不变（helpdesk_faqs.key）。 */
  key: string;
  type: FaqNodeType;
  /** true：可被新问题直接命中、可做 starter / 情境 chip；false：只能经边到达。 */
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  question: string;
  /** answer 节点：已审核答案（Markdown 子集）；choice 节点：那句提问（不含事实、数字、链接）。 */
  answer: string;
  /** answer 节点的块（至少 1 个）；choice 节点为 []。 */
  blocks: FaqBlock[];
  signals: FaqSignal[];
};

/** 快照里的一条边，某一种语言；label 已解析好（没有覆盖文字就是子节点的问题）。 */
export type FaqEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  /** 同一父节点下从 0 开始的顺序。 */
  position: number;
  label: string;
};

/**
 * GET /api/integration/helpdesk/faq-release/current?locale= 的回包（Bearer ADMIN_HELPDESK_TOKEN）：
 * 当前已发布的整张图，ETag "v<version>"，If-None-Match 命中 → 304；还没有任何发布版本 → 404
 * problem+json code no_release（Portal 照旧用逐条发布的 FAQ 列表）。
 */
export type FaqRelease = {
  version: number;
  publishedAt: string;
  locale: HelpdeskLocale;
  nodes: FaqNode[];
  edges: FaqEdge[];
};

/** 发布快照的 ETag（强校验值，与语言无关：同一版本两种语言内容都不变）。 */
export function faqReleaseEtag(version: number): string {
  return `"v${version}"`;
}

/** 推荐回包的 kind（Part B/D）：answer = 出 FAQ（或 choice 节点）；smalltalk = 寒暄；clarify = 解释刚给的卡片；no_match。 */
export const SUGGEST_KINDS = [
  'answer',
  'smalltalk',
  'clarify',
  'no_match',
] as const;
export type SuggestKind = (typeof SUGGEST_KINDS)[number];

/**
 * pick_faq 的 intent（v5）：v2 的七个 + greeting（你好、在吗、how are you）、farewell（谢谢、再见：
 * Portal 在答过之后接评分卡，所以与 greeting 分开）、vague（想求助但还没说问题）、clarify（问刚给的那张卡
 * 的意思、细节或条件）。
 */
export const SUGGEST_INTENTS = [
  'question',
  'own_account',
  'someone_else',
  'exception',
  'private_data',
  'instructions',
  'off_topic',
  'greeting',
  'farewell',
  'vague',
  'clarify',
] as const;
export type SuggestIntent = (typeof SUGGEST_INTENTS)[number];

/** pick_faq 的 confidence（graph design §4「who decides」）：unsure → 代码出 choice 节点让学员选。 */
export const CONFIDENCE_LEVELS = ['sure', 'unsure'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** 模型写的短句经代码守卫：passed = 原样用；fallback = 用了固定模板（或 clarify 不展示解释）。 */
export const GUARD_RESULTS = ['passed', 'fallback'] as const;
export type GuardResult = (typeof GUARD_RESULTS)[number];

/** 守卫回退的原因码（只记代码，不记文字）。 */
export const GUARD_REASONS = [
  'missing',
  'too_long',
  'link',
  'email',
  'digit',
  'markup',
  'blocked_phrase',
  'ai_filler',
  'script',
  'ungrounded',
  'not_covered',
  'timeout',
  'error',
] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

/** 经守卫的字段。 */
export const GUARDED_FIELDS = [
  'opening',
  'closing',
  'reply',
  'explanation',
] as const;
export type GuardedField = (typeof GUARDED_FIELDS)[number];

/** 守卫结果：fallback 列出用了模板的字段，reason 是第一个回退字段的原因。 */
export type SuggestGuard = {
  result: GuardResult;
  reason: GuardReason | null;
  fallback: GuardedField[];
};

/**
 * 守卫的长度上限（字符数，按学员的文字：中文 zh / 拉丁 en）。规则（实现归 Agent 侧的守卫）：
 * 无 URL、邮箱、数字、Markdown / 代码，不含禁用词与 AI 套话，与学员同一种文字；clarify 的解释里每个
 * 数字串、链接、邮箱、**界面文字**、金额都必须出现在那条答案里。任何一条不过 → 固定模板。
 */
export const GUARD_LIMITS = {
  opening: { zh: 30, en: 80 },
  closing: { zh: 30, en: 80 },
  reply: { zh: 80, en: 200 },
  explanation: { zh: 150, en: 350 },
} as const satisfies Record<GuardedField, { zh: number; en: number }>;

/**
 * 摘录规则（Part H）：blocks 是所选答案块 id 的连续子集，1–3 个；答案 ≤3 块或 ≤200 字时给 []
 * （= 整条答案，不显示「查看完整答案」）。
 */
export const EXCERPT_RULES = {
  maxBlocks: 3,
  wholeAnswerMaxBlocks: 3,
  wholeAnswerMaxChars: 200,
} as const;

/** 推荐请求的 context（v5，增量）：有 context 就是 v5 的 Portal。 */
export const SUGGEST_CONTEXT_LIMITS = {
  /** 最近几轮学员原文（只有学员说的话，从不含学员数据）。 */
  recentTurnsMax: 3,
  recentTurnMax: 500,
} as const;

export type SuggestRequestContext = {
  /** 学员屏幕上当前那张卡（节点 / FAQ id，小写 uuid）；Part D 的 shownFaqId 就是它。 */
  nodeId?: string;
  /** Portal 的 helpdesk_chat_sessions.id。 */
  sessionId?: string;
  /** 之前的学员原文，旧的在前，至多 3 条、每条至多 500 字。 */
  recentTurns?: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * 解析推荐请求的 context：没给（undefined / null）→ null（旧的 Portal）；给了就严格校验，
 * 不合法抛 Error(message)（调用方转 400 invalid_request）。只留给了的键。
 */
export function parseSuggestContext(
  raw: unknown,
): SuggestRequestContext | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('context must be an object');
  const body = raw as Record<string, unknown>;
  const out: SuggestRequestContext = {};
  for (const key of ['nodeId', 'sessionId'] as const) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !UUID.test(value))
      throw new Error(`context.${key} must be a UUID`);
    out[key] = value.toLowerCase();
  }
  const turns = body.recentTurns;
  if (turns !== undefined && turns !== null) {
    if (
      !Array.isArray(turns) ||
      turns.length > SUGGEST_CONTEXT_LIMITS.recentTurnsMax
    )
      throw new Error(
        `context.recentTurns must be a list of at most ${SUGGEST_CONTEXT_LIMITS.recentTurnsMax} texts`,
      );
    const texts: string[] = [];
    for (const turn of turns) {
      if (typeof turn !== 'string' || CONTEXT_CONTROL.test(turn))
        throw new Error('context.recentTurns must be plain texts');
      const text = turn.trim();
      if ([...text].length > SUGGEST_CONTEXT_LIMITS.recentTurnMax)
        throw new Error(
          `each of context.recentTurns must be at most ${SUGGEST_CONTEXT_LIMITS.recentTurnMax} characters`,
        );
      if (text !== '') texts.push(text);
    }
    out.recentTurns = texts;
  }
  return out;
}

/**
 * 推荐回包的 v5 字段（只在请求带 context 时出现；旧请求的回包与 v5 契约逐字相同）。
 * - answer：suggestion 非空，nodeId = suggestion.faqId；answer 节点 opening / closing 必有（模型写的过了守卫，
 *   否则固定模板），blocks = 摘录块 id（[] = 整条）；choice 节点（不确定时让学员选）opening / closing 为 null、
 *   blocks []、guard null。
 * - smalltalk：suggestion null、alternatives []，reply 必有（过守卫或模板），nodeId null。
 * - clarify：suggestion null、alternatives []，nodeId = context.nodeId；covered true 时 explanation 必有，
 *   covered false（答案没写到，或守卫没过）时 explanation null，Portal 显示固定文案 + 转人工卡。
 * - no_match：与 v5 一样的 suggestion null + alternatives。
 * intent / confidence 在没有调用模型时（chip、限流、超时）为 null；releaseVersion 为 null = 还没有发布版本
 * （逐条发布模式）。
 */
export type SuggestTurnFields = {
  kind: SuggestKind;
  intent: SuggestIntent | null;
  confidence: ConfidenceLevel | null;
  nodeId: string | null;
  blocks: string[];
  opening: string | null;
  closing: string | null;
  reply: string | null;
  explanation: string | null;
  covered: boolean | null;
  guard: SuggestGuard | null;
  releaseVersion: number | null;
};

export const SUGGEST_TURN_FIELDS = [
  'kind',
  'intent',
  'confidence',
  'nodeId',
  'blocks',
  'opening',
  'closing',
  'reply',
  'explanation',
  'covered',
  'guard',
  'releaseVersion',
] as const satisfies readonly (keyof SuggestTurnFields)[];

const BLOCK_ID = /^b[1-9]\d*$/;

/**
 * 一条 v5 推荐回包违反了上面哪些规则（空数组 = 合规）。纯函数，给两边的测试与 Admin 的自检用；
 * 不看事实（文字是否过守卫由守卫自己的测试锁）。
 */
export function suggestTurnProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return ['not an object'];
  const body = raw as Record<string, unknown>;
  for (const key of SUGGEST_TURN_FIELDS)
    if (!(key in body)) problems.push(`${key} is missing`);
  const isText = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '';
  const kind = body.kind;
  if (!(SUGGEST_KINDS as readonly unknown[]).includes(kind))
    problems.push('kind is unknown');
  if (
    body.intent !== null &&
    !(SUGGEST_INTENTS as readonly unknown[]).includes(body.intent)
  )
    problems.push('intent is unknown');
  if (
    body.confidence !== null &&
    !(CONFIDENCE_LEVELS as readonly unknown[]).includes(body.confidence)
  )
    problems.push('confidence is unknown');
  if (
    body.nodeId !== null &&
    (typeof body.nodeId !== 'string' || !UUID.test(body.nodeId))
  )
    problems.push('nodeId must be a UUID or null');
  const blocks = body.blocks;
  if (
    !Array.isArray(blocks) ||
    !blocks.every((id) => BLOCK_ID.test(String(id)))
  )
    problems.push('blocks must be block ids');
  else {
    const numbers = blocks.map((id) => Number(String(id).slice(1)));
    if (numbers.length > EXCERPT_RULES.maxBlocks)
      problems.push(`blocks has more than ${EXCERPT_RULES.maxBlocks} ids`);
    if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1))
      problems.push('blocks must be contiguous and in order');
  }
  for (const key of ['opening', 'closing', 'reply', 'explanation'] as const)
    if (body[key] !== null && !isText(body[key]))
      problems.push(`${key} must be text or null`);
  if (body.covered !== null && typeof body.covered !== 'boolean')
    problems.push('covered must be true, false or null');
  if (
    body.releaseVersion !== null &&
    !(Number.isInteger(body.releaseVersion) && Number(body.releaseVersion) >= 1)
  )
    problems.push('releaseVersion must be a positive integer or null');
  const guard = body.guard as Record<string, unknown> | null;
  if (guard !== null) {
    if (typeof guard !== 'object' || Array.isArray(guard))
      problems.push('guard must be an object or null');
    else {
      if (!(GUARD_RESULTS as readonly unknown[]).includes(guard.result))
        problems.push('guard.result is unknown');
      if (
        guard.reason !== null &&
        !(GUARD_REASONS as readonly unknown[]).includes(guard.reason)
      )
        problems.push('guard.reason is unknown');
      const fallback = guard.fallback;
      if (
        !Array.isArray(fallback) ||
        !fallback.every((f) =>
          (GUARDED_FIELDS as readonly unknown[]).includes(f),
        )
      )
        problems.push('guard.fallback must list guarded fields');
      else if ((guard.result === 'passed') !== (fallback.length === 0))
        problems.push('guard.fallback is empty exactly when it passed');
      if ((guard.result === 'passed') !== (guard.reason === null))
        problems.push('guard.reason is null exactly when it passed');
    }
  }
  const suggestion = body.suggestion as
    Record<string, unknown> | null | undefined;
  const alternatives = body.alternatives;
  if (!Array.isArray(alternatives)) problems.push('alternatives is missing');
  const none = (keys: readonly string[]) => {
    for (const key of keys)
      if (body[key] !== null)
        problems.push(`${key} must be null for ${String(kind)}`);
  };
  if (kind === 'answer') {
    if (!suggestion || typeof suggestion !== 'object')
      problems.push('answer needs a suggestion');
    else if (body.nodeId !== suggestion.faqId)
      problems.push('nodeId must be the suggestion faqId');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('no alternatives next to an answer');
    none(['reply', 'explanation', 'covered']);
    const framed = isText(body.opening) && isText(body.closing);
    const bare = body.opening === null && body.closing === null;
    if (!framed && !bare)
      problems.push('opening and closing come together, or both null (choice)');
    if (bare && (Array.isArray(blocks) ? blocks.length > 0 : false))
      problems.push('a choice node has no blocks');
    if (framed && guard === null) problems.push('answer text needs a guard');
  } else {
    if (suggestion !== null) problems.push(`${String(kind)} has no suggestion`);
    none(['opening', 'closing']);
    if (Array.isArray(blocks) && blocks.length > 0)
      problems.push(`${String(kind)} has no blocks`);
  }
  if (kind === 'smalltalk') {
    if (!isText(body.reply)) problems.push('smalltalk needs a reply');
    none(['nodeId', 'explanation', 'covered']);
    if (guard === null) problems.push('smalltalk needs a guard');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('smalltalk has no alternatives');
  }
  if (kind === 'clarify') {
    none(['reply']);
    if (body.nodeId === null) problems.push('clarify names the shown node');
    if (typeof body.covered !== 'boolean')
      problems.push('clarify needs covered');
    if (body.covered === true && !isText(body.explanation))
      problems.push('covered clarify needs an explanation');
    if (body.covered === false && body.explanation !== null)
      problems.push('uncovered clarify shows no explanation');
    if (guard === null) problems.push('clarify needs a guard');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('clarify has no alternatives');
  }
  if (kind === 'no_match') {
    none(['nodeId', 'reply', 'explanation', 'covered', 'guard']);
  }
  return problems;
}
