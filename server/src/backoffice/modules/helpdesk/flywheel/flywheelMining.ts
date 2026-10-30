import type { InsightTurn } from '../contracts';
import { toSimplified } from '../faqs/faqSearchText';
import type { TextSimilarity } from './textSimilarity';

/**
 * 缺口挖掘的纯逻辑（v5 Part G3；graph design §5.5 的飞轮钩子）：
 * 1. 选 AI 没解决的轮（unsolvedReasons，与迁移里视图 helpdesk_insight_turn_facts 的 gap_* 同一套规则）；
 * 2. 先看能不能并进已有的候选（待处理的，或驳回过的：驳回的不再回到队列），再按意思分组
 *    （TextSimilarity：现在是现有检索的 OpenCC + n-gram，以后可以换向量）；单独一轮的留到之后的夜里；
 * 3. 每组挑至多 5 个不重复的脱敏例句（越靠近中心越先，带占位符的往后）、原因构成、至多 3 条
 *    客服（人）解决工单时的回复（草稿来源）；
 * 4. 和已发布的节点去重：和某个节点（问题或问法）足够像 → 「加问法到 X」；否则学员多半卡在同一个
 *    节点上（打字时屏幕上的那张卡）→ 「在那个节点下加追问」；否则「新 FAQ」。
 * 话题与提议的问题由服务层问模型（GapLabeller），这里给代码兜底的那一份（codeLabel）。
 * 纯函数（embed 是异步的，所以 planMining 是 async），同样的输入给同样的计划。
 */

export const UNSOLVED_REASONS = [
  'no_match',
  'not_helpful',
  'clarify_not_covered',
  'handover',
  'ticket_after_chat',
  'low_rating',
] as const;
export type UnsolvedReason = (typeof UNSOLVED_REASONS)[number];

/** 候选的原因构成的键：上面六种 + ticket（客服从工单转来的）。 */
export const SOURCE_MIX_KEYS = [...UNSOLVED_REASONS, 'ticket'] as const;
export type SourceMixKey = (typeof SOURCE_MIX_KEYS)[number];
export type SourceMix = Partial<Record<SourceMixKey, number>>;

export const MINING_LIMITS = {
  /** 只挖最近 30 天还没归属的轮。 */
  windowDays: 30,
  /** 一晚至多看这么多轮（最新的先）。 */
  turnsMax: 2000,
  /** 一轮并进一组（和组的中心比）。 */
  groupThreshold: 0.35,
  /** 一轮并进已有的候选（和候选例句的中心比）。 */
  candidateThreshold: 0.4,
  /** 一组和已发布的节点（问题或问法）这么像 → 加问法。 */
  nodeThreshold: 0.5,
  /** 少于 2 轮的组不建候选（留到之后的夜里）。 */
  minGroup: 2,
  examplesMax: 5,
  answerSourcesMax: 3,
  /** 并进已有候选时看最近 90 天动过的候选。 */
  candidatesWindowDays: 90,
  /** 和节点比的时候每组至多看前 10 个成员（靠近中心的）。 */
  nodeCompareMax: 10,
  /** 一晚至多问模型这么多次（一组一次，大组先），以及至多花这么多（美元，价目已知时）。 */
  labelCallsMax: 30,
  labelCostMaxUsd: 0.1,
  /** 一个跨多大比例的成员停在同一个节点上，才算学员卡在那里。 */
  dominantShare: 0.5,
} as const;

/** 挖掘用的一轮（从事实表读出的 InsightTurn 的子集）。 */
export type MiningTurn = {
  id: string;
  createdAt: string;
  locale: string;
  text: string;
  kind: string | null;
  intent: string | null;
  vote: string | null;
  rating: number | null;
  covered: boolean | null;
  handover: boolean;
  ticketAfterChat: boolean;
  nodeId: string | null;
  parentNodeId: string | null;
  /** 客服解决了这张工单时客服最后一条公开回复（Portal 已脱敏）。 */
  agentReply: string | null;
};

export function miningTurn(turn: InsightTurn): MiningTurn {
  return {
    id: turn.id,
    createdAt: turn.createdAt,
    locale: turn.locale,
    text: turn.text,
    kind: turn.kind,
    intent: turn.intent,
    vote: turn.vote,
    rating: turn.rating,
    covered: turn.covered,
    handover: turn.handover,
    ticketAfterChat: turn.ticketAfterChat,
    nodeId: turn.nodeId,
    parentNodeId: turn.parentNodeId,
    agentReply:
      turn.ticket?.resolvedByAgent && turn.ticket.agentReply
        ? turn.ticket.agentReply
        : null,
  };
}

type ReasonInput = Pick<
  MiningTurn,
  'kind' | 'vote' | 'covered' | 'handover' | 'ticketAfterChat' | 'rating'
>;

/** 这一轮为什么算 AI 没解决（可以有几种；空 = 解决了或没法判断）。 */
export function unsolvedReasons(turn: ReasonInput): UnsolvedReason[] {
  const reasons: UnsolvedReason[] = [];
  if (turn.kind === 'no_match') reasons.push('no_match');
  if (turn.vote === 'not_helpful') reasons.push('not_helpful');
  if (turn.kind === 'clarify' && turn.covered === false)
    reasons.push('clarify_not_covered');
  if (turn.handover) reasons.push('handover');
  if (turn.ticketAfterChat) reasons.push('ticket_after_chat');
  if (turn.rating !== null && turn.rating <= 2) reasons.push('low_rating');
  return reasons;
}

/** 不是问题的轮：寒暄、要人工的那一轮本身、指令注入、想要别人的数据。 */
export const NOT_QUESTIONS: ReadonlySet<string> = new Set([
  'greeting',
  'farewell',
  'instructions',
  'private_data',
]);
const PLACEHOLDER = /<[a-z_]{2,16}>/g;

/** 去掉占位符与标点后还剩的字数。 */
function meaningfulLength(text: string): number {
  return [...text.replace(PLACEHOLDER, '').replace(/[\p{P}\p{S}\s]/gu, '')]
    .length;
}

/** 值得挖的轮：没解决、是个问题、去掉占位符后至少 2 个字。 */
export function mineable(turn: MiningTurn): boolean {
  if (turn.kind === 'smalltalk' || turn.kind === 'handover') return false;
  if (turn.intent !== null && NOT_QUESTIONS.has(turn.intent)) return false;
  if (meaningfulLength(turn.text) < 2) return false;
  return unsolvedReasons(turn).length > 0;
}

export type PhrasingLocale = 'en-GB' | 'zh-CN' | 'zh-TW';
const HAN = /\p{Script=Han}/u;

/** 例句的语言按学员写的字：有汉字（繁体 → zh-TW），否则 en-GB。 */
export function phrasingLocale(text: string, fallback: string): PhrasingLocale {
  if (HAN.test(text)) return toSimplified(text) !== text ? 'zh-TW' : 'zh-CN';
  if (/\p{Script=Latin}/u.test(text)) return 'en-GB';
  return fallback === 'en-GB' ? 'en-GB' : 'zh-CN';
}

export type CandidateExample = {
  turnId: string | null;
  text: string;
  locale: PhrasingLocale;
  reasons: SourceMixKey[];
};

export type NodeText = { nodeId: string; text: string };
export type OpenCandidate = { id: string; examples: readonly string[] };
export type Suggestion = 'new_faq' | 'add_phrasing' | 'follow_up';

export type PlannedGroup = {
  members: MiningTurn[];
  examples: CandidateExample[];
  sourceMix: SourceMix;
  answerSources: string[];
  /** 成员里最多的界面语言。 */
  locale: string;
  suggestion: Suggestion;
  relatedNodeId: string | null;
  relatedScore: number | null;
  parentNodeId: string | null;
  shownNodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type PlannedGrowth = {
  candidateId: string;
  members: MiningTurn[];
  examples: CandidateExample[];
  sourceMix: SourceMix;
  answerSources: string[];
  lastSeenAt: string;
};

export type MiningPlan = {
  create: PlannedGroup[];
  grow: PlannedGrowth[];
  /** 没并进任何组的单独一轮（留到之后的夜里）。 */
  singles: number;
};

function byTime(a: MiningTurn, b: MiningTurn): number {
  return a.createdAt === b.createdAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.createdAt < b.createdAt
      ? -1
      : 1;
}

export function sourceMixOf(members: readonly MiningTurn[]): SourceMix {
  const mix: SourceMix = {};
  for (const member of members)
    for (const reason of unsolvedReasons(member))
      mix[reason] = (mix[reason] ?? 0) + 1;
  return mix;
}

/** 两份原因构成相加。 */
export function addMix(a: SourceMix, b: SourceMix): SourceMix {
  const out: SourceMix = { ...a };
  for (const key of SOURCE_MIX_KEYS)
    if (b[key]) out[key] = (out[key] ?? 0) + (b[key] ?? 0);
  return out;
}

const textKey = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** 不重复的至多 n 条草稿来源（客服解决了的工单里人写的回复）。 */
export function answerSourcesOf(
  members: readonly MiningTurn[],
  existing: readonly string[] = [],
  max: number = MINING_LIMITS.answerSourcesMax,
): string[] {
  const out = [...existing].slice(0, max);
  const seen = new Set(out.map(textKey));
  for (const member of members) {
    if (out.length >= max) break;
    if (!member.agentReply) continue;
    const key = textKey(member.agentReply);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member.agentReply);
  }
  return out;
}

const placeholders = (text: string) => (text.match(PLACEHOLDER) ?? []).length;

/**
 * 至多 n 个不重复的例句：没有占位符的先，再按离中心的远近（ranked 已按远近排好）；
 * existing 里已有的排在最前面、不重复。
 */
export function examplesOf(
  ranked: readonly MiningTurn[],
  existing: readonly CandidateExample[] = [],
  max: number = MINING_LIMITS.examplesMax,
): CandidateExample[] {
  const out = [...existing].slice(0, max);
  const seen = new Set(out.map((example) => textKey(example.text)));
  const ordered = [...ranked].sort(
    (a, b) =>
      Number(placeholders(a.text) > 0) - Number(placeholders(b.text) > 0),
  );
  for (const member of ordered) {
    if (out.length >= max) break;
    const key = textKey(member.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      turnId: member.id,
      text: member.text,
      locale: phrasingLocale(member.text, member.locale),
      reasons: unsolvedReasons(member),
    });
  }
  return out;
}

/** 出现最多的值（并列取字典序小的），占比不到 share 时为 null。 */
export function dominant(
  values: readonly (string | null)[],
  share: number,
): string | null {
  const counts = new Map<string, number>();
  for (const value of values)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1)))
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  return best !== null && bestCount / values.length >= share ? best : null;
}

/** 代码写的标签（模型关着、超预算、失败或没过守卫）：最靠近中心的例句当问题，话题是它的前 24 个字。 */
export function codeLabel(examples: readonly CandidateExample[]): {
  topic: string;
  question: string;
} {
  const text = (examples[0]?.text ?? '').replace(/\s+/g, ' ').trim() || '—';
  const points = [...text];
  return {
    question: points.slice(0, 200).join(''),
    topic:
      points.length <= 24 ? text : `${points.slice(0, 23).join('').trim()}…`,
  };
}

/** 一组的节点比较：和每个节点的问题 / 问法的最高相似度。 */
function bestNode<V>(
  members: readonly V[],
  nodes: readonly { nodeId: string; vector: V }[],
  similarity: TextSimilarity<V>,
): { nodeId: string; score: number } | null {
  let best: { nodeId: string; score: number } | null = null;
  for (const node of nodes)
    for (const member of members) {
      const score = similarity.similarity(member, node.vector);
      if (
        !best ||
        score > best.score ||
        (score === best.score && node.nodeId < best.nodeId)
      )
        best = { nodeId: node.nodeId, score };
    }
  return best;
}

function majorityLocale(members: readonly MiningTurn[]): string {
  return (
    dominant(
      members.map((m) => m.locale || null),
      0,
    ) ?? 'zh-CN'
  );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** 一晚的计划（见文件头）。turns 只给还没归属、mineable 的轮。 */
export async function planMining<V>(input: {
  turns: readonly MiningTurn[];
  nodes: readonly NodeText[];
  candidates: readonly OpenCandidate[];
  similarity: TextSimilarity<V>;
  limits?: Partial<Record<keyof typeof MINING_LIMITS, number>>;
}): Promise<MiningPlan> {
  const limits: Record<keyof typeof MINING_LIMITS, number> = {
    ...MINING_LIMITS,
    ...input.limits,
  };
  const { similarity } = input;
  const turns = [...input.turns].sort(byTime);
  const candidateTexts = input.candidates.flatMap((c) => c.examples);
  const vectors = await similarity.embed([
    ...turns.map((t) => t.text),
    ...input.nodes.map((n) => n.text),
    ...candidateTexts,
  ]);
  const turnVectors = vectors.slice(0, turns.length);
  const nodeVectors = input.nodes.map((node, index) => ({
    nodeId: node.nodeId,
    vector: vectors[turns.length + index],
  }));
  let offset = turns.length + input.nodes.length;
  const candidateCentroids = input.candidates.map((candidate) => {
    const own = vectors.slice(offset, offset + candidate.examples.length);
    offset += candidate.examples.length;
    return { id: candidate.id, centroid: similarity.centroid(own) };
  });

  // 1. 能并进已有候选的轮
  const growth = new Map<string, number[]>();
  const rest: number[] = [];
  turns.forEach((_turn, index) => {
    let best: { id: string; score: number } | null = null;
    for (const candidate of candidateCentroids) {
      const score = similarity.similarity(
        turnVectors[index],
        candidate.centroid,
      );
      if (score >= limits.candidateThreshold && (!best || score > best.score))
        best = { id: candidate.id, score };
    }
    if (best) growth.set(best.id, [...(growth.get(best.id) ?? []), index]);
    else rest.push(index);
  });

  // 2. 其余的按意思分组（单遍：和每组的中心比，够像就进最像的那组，否则自成一组）
  const groups: { members: number[]; centroid: V }[] = [];
  for (const index of rest) {
    let best: { group: number; score: number } | null = null;
    groups.forEach((group, g) => {
      const score = similarity.similarity(turnVectors[index], group.centroid);
      if (score >= limits.groupThreshold && (!best || score > best.score))
        best = { group: g, score };
    });
    if (best) {
      const group = groups[(best as { group: number }).group];
      group.members.push(index);
      group.centroid = similarity.centroid(
        group.members.map((m) => turnVectors[m]),
      );
    } else groups.push({ members: [index], centroid: turnVectors[index] });
  }

  // 第二遍：单独一轮（单遍时先到、组还小）再和最终的各组中心比一次，够像就并进去
  for (const lone of groups.filter((group) => group.members.length === 1)) {
    const index = lone.members[0];
    let best: { members: number[]; centroid: V } | null = null;
    let bestScore: number = limits.groupThreshold;
    for (const group of groups) {
      if (group === lone || group.members.length < 2) continue;
      const score = similarity.similarity(turnVectors[index], group.centroid);
      if (score >= bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) {
      best.members.push(index);
      best.centroid = similarity.centroid(
        best.members.map((m) => turnVectors[m]),
      );
      lone.members = [];
    }
  }

  /** 成员按离中心的远近排（近的先，并列按时间）。 */
  const ranked = (members: number[], centroid: V) =>
    [...members]
      .map((m) => ({
        m,
        score: similarity.similarity(turnVectors[m], centroid),
      }))
      .sort((a, b) => b.score - a.score || a.m - b.m)
      .map(({ m }) => m);

  const create: PlannedGroup[] = [];
  let singles = 0;
  for (const group of groups) {
    if (group.members.length === 0) continue;
    if (group.members.length < limits.minGroup) {
      singles += group.members.length;
      continue;
    }
    const order = ranked(group.members, group.centroid);
    const members = order.map((m) => turns[m]);
    const near = bestNode(
      order.slice(0, limits.nodeCompareMax).map((m) => turnVectors[m]),
      nodeVectors,
      similarity,
    );
    const parentNodeId = dominant(
      members.map((m) => m.parentNodeId),
      limits.dominantShare,
    );
    const shownNodeId = dominant(
      members.map((m) => m.nodeId),
      limits.dominantShare,
    );
    const related = near && near.score >= limits.nodeThreshold ? near : null;
    const byTimeMembers = [...members].sort(byTime);
    create.push({
      members,
      examples: examplesOf(members),
      sourceMix: sourceMixOf(members),
      answerSources: answerSourcesOf(members),
      locale: majorityLocale(members),
      suggestion: related
        ? 'add_phrasing'
        : parentNodeId
          ? 'follow_up'
          : 'new_faq',
      relatedNodeId: related?.nodeId ?? null,
      relatedScore: related ? round(related.score) : null,
      parentNodeId,
      shownNodeId,
      firstSeenAt: byTimeMembers[0].createdAt,
      lastSeenAt: byTimeMembers[byTimeMembers.length - 1].createdAt,
    });
  }
  // 大组先（服务层按这个顺序花模型预算），并列按最早出现
  create.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (a.firstSeenAt < b.firstSeenAt
        ? -1
        : a.firstSeenAt > b.firstSeenAt
          ? 1
          : 0) ||
      (a.members[0].id < b.members[0].id ? -1 : 1),
  );

  const grow: PlannedGrowth[] = [...growth]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([candidateId, indexes]) => {
      const members = indexes.map((m) => turns[m]);
      return {
        candidateId,
        members,
        examples: examplesOf(members),
        sourceMix: sourceMixOf(members),
        answerSources: answerSourcesOf(members),
        lastSeenAt: members[members.length - 1].createdAt,
      };
    });
  return { create, grow, singles };
}
