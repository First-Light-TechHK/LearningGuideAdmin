import type { Attribute, CardType, QuestionType } from './questionType';
import type { StageKey } from './stagePrior';

/**
 * 定位方式 B 的排序（设计文档第四节第 2 到 4 步）。纯函数：数据库只给事实（每张命中卡的字词分和它挂在哪），
 * 这里做决定（选哪两个阶段或对象、子树里取哪 8 张、何时回退到全库），不连数据库就能单测和离线调参。
 */

/** 卡在结构里的一个位置（helpdesk_faq_release_placements 的一行）。 */
export type Placement = {
  node: 'step' | 'deviation' | 'cell';
  /** 流程位置 = 所在阶段；规则格子 = 对象所属的阶段（先验用）。 */
  stage: StageKey;
  /** node 为 step / deviation 时：步骤 key（如 account.verify）。 */
  step?: string;
  /** node 为 cell 时：对象 key 与属性。 */
  object?: string;
  attribute?: Attribute;
  primary: boolean;
};

export type ScoredCard = {
  id: string;
  /** 现网字词检索的分（> 0 = 命中）。 */
  score: number;
  cardType: CardType;
  placements: readonly Placement[];
};

/**
 * 消融用的变体（设计文档 7.3）：
 * B1 只分类型；B2 再按结构分层；B3 再用学员状态软加权（完整的 B）；B3-hard 用状态硬过滤（对照组）。
 */
export const LOCATOR_VARIANTS = ['B1', 'B2', 'B3', 'B3-hard'] as const;
export type LocatorVariant = (typeof LOCATOR_VARIANTS)[number];

export type LocatorParams = {
  /** 状态先验的乘性权重：阶段在先验里，分数 × (1 + w)。 */
  w: number;
  /** 卡在本区域前两名的步骤（或属性）下：× (1 + gamma)。 */
  gamma: number;
  /** 规则卡的属性正是句子里的属性词：× (1 + attributeBoost)。 */
  attributeBoost: number;
  /** 子树里最好的卡的字词分不到全库最好的 theta 倍 → 结构没找准，整份回退到全库候选。 */
  theta: number;
  /** 区域分 = 区域里前 regionTop 张卡的分之和。 */
  regionTop: number;
  /** 取几个区域（阶段或对象）。 */
  regions: number;
  /** 子树里取几张。 */
  structured: number;
  /** 再从全库候选补几张（保险）。 */
  fallback: number;
  /** 给模型的候选总数，和 A 相同。 */
  limit: number;
};

/** 开发集调参之前的初值；离线调参只在开发集上做，测试集只跑一次。 */
export const LOCATOR_DEFAULTS: LocatorParams = {
  w: 0.5,
  gamma: 0.3,
  attributeBoost: 0.3,
  theta: 0.2,
  regionTop: 3,
  regions: 2,
  structured: 8,
  fallback: 2,
  limit: 10,
};

export type StructuredInput = {
  /** 本句命中的卡（不限入口节点），任意顺序。 */
  scored: readonly ScoredCard[];
  /** A 的候选（现网全库检索的前 limit 张，按名次）。 */
  flatTop: readonly string[];
  type: QuestionType;
  prior: ReadonlySet<StageKey>;
  attributes: ReadonlySet<Attribute>;
  variant: LocatorVariant;
  params?: Partial<LocatorParams>;
};

export type StructuredResult = {
  ids: string[];
  /** 选中的区域（stage:<key> 或 object:<key>），回退时为空。 */
  regions: string[];
  fellBack: boolean;
};

const allowed = (type: QuestionType, placement: Placement) =>
  type === 'both' || (type === 'process') === (placement.node !== 'cell');

const regionOf = (placement: Placement) =>
  placement.node === 'cell'
    ? `object:${placement.object ?? ''}`
    : `stage:${placement.stage}`;

const subOf = (placement: Placement) =>
  placement.node === 'cell'
    ? `attr:${placement.attribute ?? ''}`
    : `step:${placement.step ?? ''}`;

const topSum = (scores: number[], n: number) =>
  [...scores]
    .sort((a, b) => b - a)
    .slice(0, n)
    .reduce((sum, score) => sum + score, 0);

const byScore = (
  a: { score: number; id: string },
  b: { score: number; id: string },
) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 子树的卡在前，再补全库候选，凑满 limit；去重。 */
function withFallback(
  structured: readonly string[],
  flatTop: readonly string[],
  p: LocatorParams,
): string[] {
  const ids = structured.slice(0, p.structured);
  const extra = flatTop.filter((id) => !ids.includes(id));
  ids.push(...extra.slice(0, p.fallback));
  for (const id of [
    ...extra.slice(p.fallback),
    ...structured.slice(p.structured),
  ]) {
    if (ids.length >= p.limit) break;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, p.limit);
}

export function rankStructured(input: StructuredInput): StructuredResult {
  const p: LocatorParams = { ...LOCATOR_DEFAULTS, ...input.params };
  const flat = (): StructuredResult => ({
    ids: input.flatTop.slice(0, p.limit),
    regions: [],
    fellBack: true,
  });
  const hits = input.scored.filter((card) => card.score > 0);
  if (hits.length === 0) return flat();
  const best = Math.max(...hits.map((card) => card.score));

  // B1：只按类型筛卡，不看结构
  if (input.variant === 'B1') {
    const wanted = hits
      .filter(
        (card) =>
          input.type === 'both' ||
          (input.type === 'process') === (card.cardType !== 'rule'),
      )
      .sort(byScore);
    if (!wanted.length || wanted[0].score < p.theta * best) return flat();
    return {
      ids: withFallback(
        wanted.map((card) => card.id),
        input.flatTop,
        p,
      ),
      regions: [],
      fellBack: false,
    };
  }

  const usePrior = input.variant === 'B3' || input.variant === 'B3-hard';
  const regionStage = new Map<string, StageKey>();
  const regionScores = new Map<string, number[]>();
  for (const card of hits)
    for (const region of new Set(
      card.placements
        .filter((placement) => allowed(input.type, placement))
        .map((placement) => {
          regionStage.set(regionOf(placement), placement.stage);
          return regionOf(placement);
        }),
    ))
      regionScores.set(region, [
        ...(regionScores.get(region) ?? []),
        card.score,
      ]);
  if (regionScores.size === 0) return flat();

  const inPrior = (region: string) => {
    const stage = regionStage.get(region);
    return usePrior && stage !== undefined && input.prior.has(stage);
  };
  const multiplier = (region: string) =>
    input.variant === 'B3' && inPrior(region) ? 1 + p.w : 1;
  let ranked = [...regionScores]
    .map(([region, scores]) => ({
      id: region,
      score: topSum(scores, p.regionTop) * multiplier(region),
    }))
    .sort(byScore);
  // 硬过滤：先验里有命中的区域就只留这些；一个都没有就不过滤
  if (
    input.variant === 'B3-hard' &&
    ranked.some((region) => inPrior(region.id))
  )
    ranked = ranked.filter((region) => inPrior(region.id));
  const chosen = ranked.slice(0, p.regions).map((region) => region.id);

  // 每个选中区域里前两名的步骤（或属性）
  const topSubs = new Set<string>();
  for (const region of chosen) {
    const subScores = new Map<string, number[]>();
    for (const card of hits)
      for (const placement of card.placements)
        if (allowed(input.type, placement) && regionOf(placement) === region)
          subScores.set(subOf(placement), [
            ...(subScores.get(subOf(placement)) ?? []),
            card.score,
          ]);
    [...subScores]
      .map(([sub, scores]) => ({ id: sub, score: topSum(scores, 2) }))
      .sort(byScore)
      .slice(0, 2)
      .forEach((sub) => topSubs.add(`${region}|${sub.id}`));
  }

  const structured = hits
    .map((card) => {
      let score = 0;
      for (const placement of card.placements) {
        const region = regionOf(placement);
        if (!allowed(input.type, placement) || !chosen.includes(region))
          continue;
        const sub = topSubs.has(`${region}|${subOf(placement)}`)
          ? 1 + p.gamma
          : 1;
        const attribute =
          placement.node === 'cell' &&
          placement.attribute !== undefined &&
          input.attributes.has(placement.attribute)
            ? 1 + p.attributeBoost
            : 1;
        score = Math.max(
          score,
          card.score * multiplier(region) * sub * attribute,
        );
      }
      return { id: card.id, score, raw: card.score };
    })
    .filter((card) => card.score > 0)
    .sort(byScore);
  if (
    !structured.length ||
    Math.max(...structured.map((card) => card.raw)) < p.theta * best
  )
    return flat();
  return {
    ids: withFallback(
      structured.map((card) => card.id),
      input.flatTop,
      p,
    ),
    regions: chosen,
    fellBack: false,
  };
}
