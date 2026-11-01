import {
  ATTRIBUTES,
  attributeHints,
  questionType,
  type Attribute,
  type CardType,
} from './locator/questionType';
import { STAGES, type StageKey } from './locator/stagePrior';
import {
  rankStructured,
  type LocatorParams,
  type LocatorVariant,
  type Placement,
  type ScoredCard,
} from './locator/structuredRank';

/**
 * FAQ 的流程树与对象表（设计文档「Helpdesk 定位方式对比」第三到五节，迁移 20261031120000）。纯函数：
 * - 编辑区的行（helpdesk_faq_map_nodes / helpdesk_faq_placements）发布时冻结进快照（freezeMap）；
 * - 发布检查（mapProblems，由 checkFaqGraph 调用）；
 * - 运行时：从快照建索引（locatorIndex，按快照对象缓存），在全库检索已经拿到的命中里挑「结构上最像」的
 *   几张放在候选最前面（locatorHead）。不多查数据库：A 的检索本来就取了前 100 条命中。
 *
 * 离线对比（S650 开发集 1,106 题，2026-10-31）：B 的前 3 张 + A 原来的 10 张，对的卡在候选里
 * 97.9% → 98.1%（A 找得到的一题不丢），排第一 54.8% → 76.9%，提示词长 1.8%，排序约 0.1 毫秒。
 */

export const MAP_NODE_KINDS = [
  'stage',
  'step',
  'deviation',
  'object',
  'cell',
] as const;
export type FaqMapNodeKind = (typeof MAP_NODE_KINDS)[number];

/** 卡能挂的节点 → 卡的类型（主位置决定类型，所以 helpdesk_faqs 不另存）。 */
export const CARD_TYPE_OF_KIND = {
  step: 'how_to',
  deviation: 'troubleshoot',
  cell: 'rule',
} as const satisfies Record<string, CardType>;
export type PlaceableKind = keyof typeof CARD_TYPE_OF_KIND;

export const isPlaceable = (kind: FaqMapNodeKind): kind is PlaceableKind =>
  kind in CARD_TYPE_OF_KIND;

/** 编辑区的节点（helpdesk_faq_map_nodes 一行）。 */
export type FaqMapNode = {
  id: string;
  key: string;
  kind: FaqMapNodeKind;
  parentId: string | null;
  /** 只有对象有：它属于哪个阶段。 */
  stageId: string | null;
  /** 只有格子有。 */
  attribute: Attribute | null;
  position: number;
  labelEn: string;
  labelZh: string;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 编辑区的挂载（helpdesk_faq_placements 一行）。 */
export type FaqPlacement = {
  id: string;
  faqId: string;
  nodeId: string;
  primary: boolean;
  createdBy: string | null;
  createdAt: string;
};

export type FaqSnapshotMapNode = Pick<
  FaqMapNode,
  | 'id'
  | 'key'
  | 'kind'
  | 'parentId'
  | 'stageId'
  | 'attribute'
  | 'position'
  | 'labelEn'
  | 'labelZh'
>;
export type FaqSnapshotPlacement = Pick<
  FaqPlacement,
  'faqId' | 'nodeId' | 'primary'
>;

/** 快照里的结构；没有任何结构节点时快照里不出现（指纹与加这张表之前一样）。 */
export type FaqSnapshotMap = {
  nodes: FaqSnapshotMapNode[];
  placements: FaqSnapshotPlacement[];
};

/**
 * 冻结：节点按 key 排序；只要已发布节点上的挂载（按 faqId、nodeId 排序）。同样的编辑区永远得到同样的结构。
 */
export function freezeMap(
  nodes: readonly FaqMapNode[],
  placements: readonly Pick<FaqPlacement, 'faqId' | 'nodeId' | 'primary'>[],
  publishedIds: ReadonlySet<string>,
): FaqSnapshotMap | undefined {
  if (nodes.length === 0) return undefined;
  return {
    nodes: [...nodes]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((node) => ({
        id: node.id,
        key: node.key,
        kind: node.kind,
        parentId: node.parentId,
        stageId: node.stageId,
        attribute: node.attribute,
        position: node.position,
        labelEn: node.labelEn,
        labelZh: node.labelZh,
      })),
    placements: placements
      .filter((placement) => publishedIds.has(placement.faqId))
      .map((placement) => ({
        faqId: placement.faqId,
        nodeId: placement.nodeId,
        primary: placement.primary,
      }))
      .sort(
        (a, b) =>
          a.faqId.localeCompare(b.faqId) || a.nodeId.localeCompare(b.nodeId),
      ),
  };
}

export type MapProblem = {
  rule: 'map_shape' | 'map_placement' | 'map_primary';
  nodeId: string | null;
  key: string | null;
  detail: string;
};

/**
 * 发布前的结构检查（编辑时数据库已经拦住了大部分，这里再对快照查一遍，同一快照同样结果）：
 * - map_shape：阶段在根上、步骤在阶段下、岔子在步骤下、对象在根上且属于一个阶段、格子在对象下且有属性，
 *   对象和格子的 key 在 rules. 下（和同名的阶段分开）；
 * - map_placement：挂载指向快照里的步骤、岔子或格子；
 * - map_primary：挂了的卡恰好一个主位置（编辑途中允许暂时没有，发布时不行）。
 * 没挂的卡不算问题：新加的卡先发布，挂上以前只走全库检索。
 */
export function mapProblems(
  map: FaqSnapshotMap,
  keyOf: (faqId: string) => string | null,
): MapProblem[] {
  const problems: MapProblem[] = [];
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const parentKind: Record<FaqMapNodeKind, FaqMapNodeKind | null> = {
    stage: null,
    step: 'stage',
    deviation: 'step',
    object: null,
    cell: 'object',
  };
  for (const node of map.nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const stage = node.stageId ? byId.get(node.stageId) : undefined;
    const want = parentKind[node.kind];
    const ok =
      (want === null
        ? node.parentId === null
        : parent !== undefined && parent.kind === want) &&
      (node.kind === 'object'
        ? stage !== undefined && stage.kind === 'stage'
        : node.stageId === null) &&
      (node.kind === 'cell') === (node.attribute !== null) &&
      (node.kind === 'object' || node.kind === 'cell') ===
        node.key.startsWith('rules.') &&
      (node.attribute === null || ATTRIBUTES.includes(node.attribute));
    if (!ok)
      problems.push({
        rule: 'map_shape',
        nodeId: node.id,
        key: node.key,
        detail: `${node.key}: a ${node.kind} is in the wrong place in the map`,
      });
  }
  const primaries = new Map<string, number>();
  for (const placement of map.placements) {
    const node = byId.get(placement.nodeId);
    if (!node || !isPlaceable(node.kind))
      problems.push({
        rule: 'map_placement',
        nodeId: placement.faqId,
        key: keyOf(placement.faqId),
        detail: `${keyOf(placement.faqId) ?? placement.faqId} hangs on ${node ? `a ${node.kind}` : 'a node that is not in the map'}`,
      });
    primaries.set(
      placement.faqId,
      (primaries.get(placement.faqId) ?? 0) + (placement.primary ? 1 : 0),
    );
  }
  for (const [faqId, count] of primaries)
    if (count !== 1)
      problems.push({
        rule: 'map_primary',
        nodeId: faqId,
        key: keyOf(faqId),
        detail: `${keyOf(faqId) ?? faqId} has ${count} primary places in the map (needs exactly 1)`,
      });
  return problems;
}

/* ------------------------------------------------------------- 运行时 */

/** 每张挂了的卡：类型（主位置定）与它的全部位置（带阶段）。 */
export type LocatorIndex = Map<
  string,
  { cardType: CardType; placements: Placement[] }
>;

const indexes = new WeakMap<FaqSnapshotMap, LocatorIndex>();

/** 快照结构 → 索引；同一个快照对象只建一次（快照按发布版本缓存在进程里，写入后不再改）。 */
export function locatorIndex(map: FaqSnapshotMap): LocatorIndex {
  const cached = indexes.get(map);
  if (cached) return cached;
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const stageKey = (id: string | null): StageKey | null => {
    const key = id ? byId.get(id)?.key : undefined;
    return key !== undefined && (STAGES as readonly string[]).includes(key)
      ? (key as StageKey)
      : null;
  };
  const placementOf = (
    node: FaqSnapshotMapNode,
    primary: boolean,
  ): Placement | null => {
    if (node.kind === 'cell') {
      const object = node.parentId ? byId.get(node.parentId) : undefined;
      const stage = stageKey(object?.stageId ?? null);
      return object && stage && node.attribute
        ? {
            node: 'cell',
            stage,
            object: object.key,
            attribute: node.attribute,
            primary,
          }
        : null;
    }
    const step =
      node.kind === 'deviation' ? byId.get(node.parentId ?? '') : node;
    const stage = stageKey(step?.parentId ?? null);
    return step && stage && (node.kind === 'step' || node.kind === 'deviation')
      ? { node: node.kind, stage, step: step.key, primary }
      : null;
  };
  const index: LocatorIndex = new Map();
  for (const placement of map.placements) {
    const node = byId.get(placement.nodeId);
    const resolved = node ? placementOf(node, placement.primary) : null;
    if (!node || !resolved || !isPlaceable(node.kind)) continue;
    const entry = index.get(placement.faqId) ?? {
      cardType: CARD_TYPE_OF_KIND[node.kind],
      placements: [],
    };
    if (placement.primary) entry.cardType = CARD_TYPE_OF_KIND[node.kind];
    entry.placements.push(resolved);
    index.set(placement.faqId, entry);
  }
  // 主位置排在前面（rankStructured 不看顺序，日志与调试好读）
  for (const entry of index.values())
    entry.placements.sort((a, b) => Number(b.primary) - Number(a.primary));
  indexes.set(map, index);
  return index;
}

/**
 * 结合方案的参数（开发集上调的，测试集只跑一次）：问题类型的门槛 1.5、取 3 个区域，不用学员状态加权：
 * 开发集上状态和消息一致时排第一只多 0.4 个点，状态和消息不符时少 1.0 个点（权重 0.25）到 9.6 个点
 * （权重 1）。状态照旧作为事实交给模型（v7 LEARNER_STATE_RULE）。
 */
export const LOCATOR_HEAD = {
  head: 3,
  typeMargin: 1.5,
  variant: 'B2' as LocatorVariant,
  params: { regions: 3 } satisfies Partial<LocatorParams>,
} as const;

/**
 * 结构排序的前 head 张（id）：放在 A 的候选前面，A 的候选一张不少。
 * scored = 这一句的全库检索命中（不限入口节点）；flatTop = A 的候选（按名次，问题类型的检索信号用）。
 * 结构说不准（没命中挂了的卡、或子树里最好的卡远不如全库最好的）→ 空：候选与 A 完全一样。
 */
export function locatorHead(input: {
  index: LocatorIndex;
  text: string;
  scored: readonly { id: string; score: number }[];
  flatTop: readonly string[];
  head?: number;
}): string[] {
  const head = input.head ?? LOCATOR_HEAD.head;
  if (head <= 0 || input.index.size === 0) return [];
  const scored: ScoredCard[] = input.scored.flatMap((hit) => {
    const entry = input.index.get(hit.id);
    return entry && hit.score > 0
      ? [{ id: hit.id, score: hit.score, ...entry }]
      : [];
  });
  if (scored.length === 0) return [];
  const topTypes = input.flatTop.flatMap((id) => {
    const entry = input.index.get(id);
    return entry ? [entry.cardType] : [];
  });
  const result = rankStructured({
    scored,
    flatTop: [],
    type: questionType(input.text, topTypes, LOCATOR_HEAD.typeMargin),
    prior: new Set(),
    attributes: attributeHints(input.text),
    variant: LOCATOR_HEAD.variant,
    params: {
      ...LOCATOR_HEAD.params,
      structured: head,
      fallback: 0,
      limit: head,
    },
  });
  return result.fellBack ? [] : result.ids;
}
