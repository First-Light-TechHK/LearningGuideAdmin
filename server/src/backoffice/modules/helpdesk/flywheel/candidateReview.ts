import type { FaqPhrasing, HelpdeskFaq } from '../faqs/faqContracts';
import type { FaqMapNode, FaqPlacement } from '../faqs/faqMap';
import type { FaqCandidate } from './candidateRepository';
import type { SourceMix, SourceMixKey, Suggestion } from './flywheelMining';
import type { TextSimilarity } from './textSimilarity';

/**
 * FAQ 候选的审核数据（owner 2026-10-31：AI 只给建议，员工看详细信息和提问用户的状态再批准）。
 * 只读、不调模型。接口说明：/mnt/project-files/lg-helpdesk/candidate-review/api-spec.md 第 2 节。
 *
 * - similar：编辑区里没归档的回答卡，和这个候选的提议问题、例句最像的至多 10 张（每张卡取它的问题、
 *   问法里最像的一句）。发布版有向量时用向量（相似度和线上检索同一个模型），否则用挖掘同一套的
 *   OpenCC + n-gram；两种分数不混用，similaritySource 说明是哪一种。
 * - places / regions：按最像的卡挂在哪里投票（每个位置加总它最好的 3 张，离线留一法实测：前 3 个区域
 *   含正确区域 86.6%，前 3 个节点只有 45.7%），所以只是提示，员工在整棵树里选。
 * - closeMatch：同位置、向量相似度 ≥ 0.88。字面相似度分不开重复、矛盾与不同情境（28 对 AI 判读过的
 *   卡对上试过），所以只提示「两张都读一下」，不判是哪一种。
 * - userStates（要 Portal 加字段）与 netValue（发布时按卡算）后面的阶段才有，现在是 null。
 */

export const REVIEW_LIMITS = {
  similarMax: 10,
  placesMax: 3,
  regionsMax: 3,
  /** 每个位置加总最好的几张。 */
  votesPerPlace: 3,
  /** 同位置、向量相似度至少这么高 → closeMatch（2026-10-31 离线：同节点 28 对里 13 对要处理）。 */
  closeMatchMin: 0.88,
  excerptChars: 200,
} as const;

export type PlacePathItem = { key: string; labelZh: string; labelEn: string };

export type SimilarCard = {
  faqId: string;
  key: string;
  questionEn: string;
  questionZh: string;
  answerExcerptEn: string;
  answerExcerptZh: string;
  entry: boolean;
  score: number;
  samePlace: boolean;
  placePath: PlacePathItem[];
  closeMatch: boolean;
};

export type SuggestedPlace = {
  nodeId: string;
  kind: FaqMapNode['kind'];
  path: PlacePathItem[];
  score: number;
};

export type SuggestedRegion = {
  key: string;
  kind: 'stage' | 'object';
  labelZh: string;
  labelEn: string;
  score: number;
};

export type HandlingRow = {
  exampleIndex: number;
  shownFaqId: string | null;
  outcome: SourceMixKey | null;
  /** AI 的回答就是卡片原文，没有单独存文字：看 shownFaqId 那张卡。 */
  reply: null;
};

export type CandidateReview = {
  candidateId: string;
  version: number;
  recommendation: {
    action: Suggestion;
    faqId: string | null;
    rationale: string;
    rationaleZh: string;
    rationaleEn: string;
    confidence: null;
  };
  handling: HandlingRow[];
  similaritySource: 'text' | 'vectors';
  similar: SimilarCard[];
  places: SuggestedPlace[];
  regions: SuggestedRegion[];
  userStates: null;
  netValue: null;
};

export type ReviewInput = {
  candidate: FaqCandidate;
  /** 编辑区（没归档的）：卡、问法、结构。 */
  working: {
    faqs: readonly HelpdeskFaq[];
    phrasings: readonly FaqPhrasing[];
    map: { nodes: readonly FaqMapNode[]; placements: readonly FaqPlacement[] };
  };
  /** 例句对应的那一轮当时给用户看的卡（insights 事实表；工单转来的没有）。 */
  shownByTurn: ReadonlyMap<string, string | null>;
  /** 每张卡的分数（0..1，越大越像）：向量或文字，见 source。 */
  scores: ReadonlyMap<string, number>;
  source: 'text' | 'vectors';
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function clip(text: string, max: number): string {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length <= max
    ? points.join('')
    : `${points.slice(0, max - 1).join('')}…`;
}

/** 一个结构节点从根到它自己的路径（对象下的格子：对象 → 格子）。 */
export function pathOf(
  nodeId: string,
  byId: ReadonlyMap<string, FaqMapNode>,
): PlacePathItem[] {
  const out: PlacePathItem[] = [];
  let node = byId.get(nodeId);
  while (node) {
    out.unshift({
      key: node.key,
      labelZh: node.labelZh,
      labelEn: node.labelEn,
    });
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return out;
}

/** 位置所在的区域：格子 → 它的对象；步骤、岔子 → 它们的阶段。 */
export function regionOf(
  nodeId: string,
  byId: ReadonlyMap<string, FaqMapNode>,
): FaqMapNode | null {
  let node = byId.get(nodeId);
  while (node && node.parentId) node = byId.get(node.parentId);
  return node && (node.kind === 'stage' || node.kind === 'object')
    ? node
    : null;
}

/** 每个键加总它最好的 n 个分数，按总分排（并列按键）。 */
function vote(
  entries: readonly { key: string; score: number }[],
  n: number,
): { key: string; score: number }[] {
  const byKey = new Map<string, number[]>();
  for (const { key, score } of entries)
    byKey.set(key, [...(byKey.get(key) ?? []), score]);
  return [...byKey]
    .map(([key, scores]) => ({
      key,
      score: round(
        [...scores]
          .sort((a, b) => b - a)
          .slice(0, n)
          .reduce((sum, s) => sum + s, 0),
      ),
    }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
}

const MIX_ZH: Record<SourceMixKey, string> = {
  no_match: '没找到卡',
  not_helpful: '说没帮上',
  clarify_not_covered: '问清楚后仍没有合适的卡',
  handover: '转人工',
  ticket_after_chat: '看完开工单',
  low_rating: '打低分',
  ticket: '从工单转来',
};
const MIX_EN: Record<SourceMixKey, string> = {
  no_match: 'no card found',
  not_helpful: 'marked not helpful',
  clarify_not_covered: 'still no card after clarifying',
  handover: 'asked for a person',
  ticket_after_chat: 'opened a ticket afterwards',
  low_rating: 'low rating',
  ticket: 'from a ticket',
};
const MIX_ORDER: SourceMixKey[] = [
  'no_match',
  'not_helpful',
  'clarify_not_covered',
  'handover',
  'ticket_after_chat',
  'low_rating',
  'ticket',
];

function mixText(mix: SourceMix): { zh: string; en: string } {
  const parts = MIX_ORDER.filter((key) => (mix[key] ?? 0) > 0);
  if (parts.length === 0) return { zh: '', en: '' };
  return {
    zh: `（${parts.map((key) => `${MIX_ZH[key]} ${mix[key]} 次`).join('、')}）`,
    en: ` (${parts.map((key) => `${MIX_EN[key]} ${mix[key]}`).join(', ')})`,
  };
}

/** 一句话说明为什么这样建议：代码按数字写，不调模型。 */
export function rationaleOf(
  candidate: FaqCandidate,
  faqs: ReadonlyMap<string, HelpdeskFaq>,
  bestScore: number | null,
): { zh: string; en: string } {
  const n = candidate.turnCount;
  const mix = mixText(candidate.sourceMix);
  const target = candidate.relatedNodeId
    ? faqs.get(candidate.relatedNodeId)
    : undefined;
  const parent = candidate.parentNodeId
    ? faqs.get(candidate.parentNodeId)
    : undefined;
  const zhQ = (faq: HelpdeskFaq | undefined) =>
    faq ? `「${clip(faq.questionZh, 40)}」` : '这张卡';
  const enQ = (faq: HelpdeskFaq | undefined) =>
    faq ? `"${clip(faq.questionEn, 60)}"` : 'this card';
  const score =
    candidate.relatedScore === null ? '' : String(candidate.relatedScore);
  switch (candidate.suggestion) {
    case 'add_phrasing':
      return {
        zh: `${n} 次提问和${zhQ(target)}很像（相似度 ${score}），但当时没给用户看这张卡，多半是没被找到${mix.zh}。`,
        en: `${n} questions are close to ${enQ(target)} (similarity ${score}) but users were not shown it, so it was probably not found${mix.en}.`,
      };
    case 'update_faq':
      return {
        zh: `${n} 次提问和${zhQ(target)}很像（相似度 ${score}），当时给用户看的就是这张卡，仍没解决${mix.zh}。`,
        en: `${n} questions are close to ${enQ(target)} (similarity ${score}); users were shown this card and it still did not solve it${mix.en}.`,
      };
    case 'follow_up':
      return {
        zh: `${n} 次提问都是在看${zhQ(parent)}时问的，问的是它没讲到的事${mix.zh}。`,
        en: `${n} questions were asked while reading ${enQ(parent)}, about something it does not cover${mix.en}.`,
      };
    case 'retire_faq':
      return {
        zh: `建议下线${zhQ(target)}：同一位置有几乎一样的卡。`,
        en: `Suggest retiring ${enQ(target)}: a nearly identical card sits in the same place.`,
      };
    default: {
      const best =
        bestScore === null
          ? ''
          : `最像的已有卡相似度只有 ${round(bestScore)}。`;
      const bestEn =
        bestScore === null
          ? ''
          : ` The closest existing card scores only ${round(bestScore)}.`;
      return {
        zh: `${n} 次提问没有合适的卡${mix.zh}。${best}`,
        en: `${n} questions had no fitting card${mix.en}.${bestEn}`,
      };
    }
  }
}

/** 审核数据（纯函数：数据都由调用方读好）。 */
export function buildCandidateReview(input: ReviewInput): CandidateReview {
  const { candidate, working, scores, source } = input;
  const faqs = new Map(working.faqs.map((faq) => [faq.id, faq]));
  const byId = new Map(working.map.nodes.map((node) => [node.id, node]));
  const primary = new Map<string, string>();
  for (const p of working.map.placements)
    if (p.primary && faqs.has(p.faqId)) primary.set(p.faqId, p.nodeId);

  const ranked = [...scores]
    .filter(([id]) => faqs.get(id)?.type === 'answer')
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const top = ranked.slice(0, REVIEW_LIMITS.similarMax);

  // 位置：最像的卡（至多 10 张）挂在哪里投票
  const placed = top
    .filter(([id]) => primary.has(id))
    .map(([id, score]) => ({ nodeId: primary.get(id)!, score }));
  const places: SuggestedPlace[] = vote(
    placed.map((p) => ({ key: p.nodeId, score: p.score })),
    REVIEW_LIMITS.votesPerPlace,
  )
    .slice(0, REVIEW_LIMITS.placesMax)
    .map(({ key, score }) => ({
      nodeId: key,
      kind: byId.get(key)!.kind,
      path: pathOf(key, byId),
      score,
    }));
  const regions: SuggestedRegion[] = vote(
    placed.flatMap((p) => {
      const region = regionOf(p.nodeId, byId);
      return region ? [{ key: region.id, score: p.score }] : [];
    }),
    REVIEW_LIMITS.votesPerPlace,
  )
    .slice(0, REVIEW_LIMITS.regionsMax)
    .map(({ key, score }) => {
      const region = byId.get(key)!;
      return {
        key: region.key,
        kind: region.kind as 'stage' | 'object',
        labelZh: region.labelZh,
        labelEn: region.labelEn,
        score,
      };
    });

  // 「同位置」的参照：候选指的那张卡（加问法、更新、下线）或父卡（追问）的主位置；新卡用建议的第一个位置
  const anchorCard = candidate.relatedNodeId ?? candidate.parentNodeId;
  const anchor =
    (anchorCard ? primary.get(anchorCard) : undefined) ??
    places[0]?.nodeId ??
    null;

  // 同位置的排前面，再按分数（候选指的那张卡自己也列出来：员工要对照着看）
  const similar: SimilarCard[] = top
    .map(([id, score]) => {
      const faq = faqs.get(id)!;
      const place = primary.get(id) ?? null;
      const samePlace = anchor !== null && place === anchor;
      return {
        faqId: id,
        key: faq.key,
        questionEn: faq.questionEn,
        questionZh: faq.questionZh,
        answerExcerptEn: clip(faq.answerEn, REVIEW_LIMITS.excerptChars),
        answerExcerptZh: clip(faq.answerZh, REVIEW_LIMITS.excerptChars),
        entry: faq.entry,
        score: round(score),
        samePlace,
        placePath: place ? pathOf(place, byId) : [],
        closeMatch:
          source === 'vectors' &&
          samePlace &&
          score >= REVIEW_LIMITS.closeMatchMin,
      };
    })
    .sort(
      (a, b) =>
        Number(b.samePlace) - Number(a.samePlace) ||
        b.score - a.score ||
        (a.faqId < b.faqId ? -1 : 1),
    );

  const handling: HandlingRow[] = candidate.examples.map((example, index) => ({
    exampleIndex: index,
    shownFaqId: example.turnId
      ? (input.shownByTurn.get(example.turnId) ?? null)
      : null,
    outcome:
      example.reasons[0] ?? (candidate.origin === 'ticket' ? 'ticket' : null),
    reply: null,
  }));

  const rationale = rationaleOf(
    candidate,
    faqs,
    ranked.length > 0 ? ranked[0][1] : null,
  );
  return {
    candidateId: candidate.id,
    version: candidate.version,
    recommendation: {
      action: candidate.suggestion,
      faqId:
        candidate.suggestion === 'follow_up'
          ? candidate.parentNodeId
          : candidate.relatedNodeId,
      rationale: candidate.locale === 'en-GB' ? rationale.en : rationale.zh,
      rationaleZh: rationale.zh,
      rationaleEn: rationale.en,
      confidence: null,
    },
    handling,
    similaritySource: source,
    similar,
    places,
    regions,
    userStates: null,
    netValue: null,
  };
}

/** 文字相似度：候选的提议问题与例句 × 每张卡的问题与问法，每张卡取最高。 */
export async function textScores<V>(
  queries: readonly string[],
  cards: readonly { nodeId: string; text: string }[],
  similarity: TextSimilarity<V>,
): Promise<Map<string, number>> {
  const texts = queries.filter((q) => q.trim() !== '');
  if (texts.length === 0 || cards.length === 0) return new Map();
  const vectors = await similarity.embed([
    ...texts,
    ...cards.map((c) => c.text),
  ]);
  const out = new Map<string, number>();
  cards.forEach((card, index) => {
    const vector = vectors[texts.length + index];
    let best = out.get(card.nodeId) ?? 0;
    for (let q = 0; q < texts.length; q += 1)
      best = Math.max(best, similarity.similarity(vectors[q], vector));
    out.set(card.nodeId, best);
  });
  return out;
}
