import { createHash } from 'node:crypto';

import {
  faqReleaseEtag,
  isHelpdeskLocale,
  type FaqBlock,
  type FaqCategory,
  type FaqEdgeKind,
  type FaqNodeType,
  type FaqRelease,
  type FaqSignal,
  type HelpdeskLocale,
} from '../../../../contracts/helpdesk-qa';
import { HelpdeskError } from '../portalHelpdeskClient';
import { splitAnswerBlocks } from './faqBlocks';
import type { FaqEdgeRow, FaqPhrasing, HelpdeskFaq } from './faqContracts';
import {
  freezeMap,
  type FaqMapNode,
  type FaqPlacement,
  type FaqSnapshotMap,
} from './faqMap';

/**
 * FAQ 问题树的发布快照（helpdesk-v5-faq-graph-design §2.2、§4「Caching」）：
 * - 快照（helpdesk_faq_releases.snapshot，写入后不再改）存双语的整张图，答案块在发布时由代码切好；
 * - Portal 经 GET /api/integration/helpdesk/faq-release/current?locale= 读某一种语言（publicRelease），
 *   ETag "v<version>"，If-None-Match 命中 → 304，还没有发布版本 → 404 no_release；
 * - 运行时（Admin 推荐与 Portal）只读已发布的快照，从不读工作表。
 * 发布表、检查与评测门由发布流程实现，经 FaqReleaseSource 交给这里。
 */

/** 快照里的节点（双语）。 */
export type FaqSnapshotNode = {
  id: string;
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  /** answer 节点：splitAnswerBlocks(answerEn / answerZh)；choice 节点：[]。 */
  blocksEn: FaqBlock[];
  blocksZh: FaqBlock[];
  signals: FaqSignal[];
  /** 检索用（不发给 Portal）。 */
  keywords: string[];
  /** 冻结时这条 FAQ 的 version 与更新时间（差异与 Help Centre 排序用；不发给 Portal）。 */
  version: number;
  updatedAt: string;
};

/** 快照里的边（双语）；label 为 null = 用子节点的问题。 */
export type FaqSnapshotEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  labelEn: string | null;
  labelZh: string | null;
};

/** 学员的问法（检索用，不发给 Portal）。 */
export type FaqSnapshotPhrasing = {
  faqId: string;
  locale: 'en-GB' | 'zh-CN' | 'zh-TW';
  text: string;
};

export type FaqReleaseSnapshot = {
  nodes: FaqSnapshotNode[];
  edges: FaqSnapshotEdge[];
  phrasings: FaqSnapshotPhrasing[];
  /** 流程树与对象表（faqMap.ts）；编辑区没有结构节点时不出现，指纹与加结构之前一样。 */
  map?: FaqSnapshotMap;
};

/** 当前已发布的那一版（status = published 的唯一一行）。 */
export type PublishedFaqRelease = {
  version: number;
  publishedAt: string;
  snapshot: FaqReleaseSnapshot;
};

export const HELPDESK_FAQ_RELEASE_SOURCE = Symbol(
  'HELPDESK_FAQ_RELEASE_SOURCE',
);

/** 已发布快照的只读来源（实现归发布流程）；没有任何发布版本 → null。 */
export interface FaqReleaseSource {
  current(): Promise<PublishedFaqRelease | null>;
}

/** 第一版发布之前：没有快照，Portal 照旧读逐条发布的 FAQ。 */
export const noFaqReleases: FaqReleaseSource = {
  current: () => Promise.resolve(null),
};

/** 发布时冻结一个节点：answer 节点按语言切块，choice 节点没有块。 */
export function freezeNode(
  node: Omit<FaqSnapshotNode, 'blocksEn' | 'blocksZh'>,
): FaqSnapshotNode {
  const answer = node.type === 'answer';
  return {
    ...node,
    blocksEn: answer ? splitAnswerBlocks(node.answerEn) : [],
    blocksZh: answer ? splitAnswerBlocks(node.answerZh) : [],
  };
}

/** 快照 → Portal 读到的某一种语言（与 PublicFaq 一样挑字段；边的 label 解析成文字）。 */
export function publicRelease(
  release: PublishedFaqRelease,
  locale: HelpdeskLocale,
): FaqRelease {
  const zh = locale === 'zh-CN';
  const questions = new Map(
    release.snapshot.nodes.map((node) => [
      node.id,
      zh ? node.questionZh : node.questionEn,
    ]),
  );
  return {
    version: release.version,
    publishedAt: release.publishedAt,
    locale,
    nodes: release.snapshot.nodes.map((node) => ({
      id: node.id,
      key: node.key,
      type: node.type,
      entry: node.entry,
      category: node.category,
      popular: node.popular,
      question: zh ? node.questionZh : node.questionEn,
      answer: zh ? node.answerZh : node.answerEn,
      blocks: zh ? node.blocksZh : node.blocksEn,
      signals: node.signals,
    })),
    edges: release.snapshot.edges.map((edge) => ({
      parentId: edge.parentId,
      childId: edge.childId,
      kind: edge.kind,
      position: edge.position,
      label:
        (zh ? edge.labelZh : edge.labelEn) ?? questions.get(edge.childId) ?? '',
    })),
  };
}

/** RFC 9110 §13.1.2 If-None-Match：逗号分隔、弱比较、* 命中任意。 */
export function ifNoneMatchHits(
  header: string | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  return header
    .split(',')
    .map(strip)
    .some((tag) => tag === '*' || tag === strip(etag));
}

export type CurrentReleaseResult =
  | { kind: 'none' }
  | { kind: 'ok'; etag: string; notModified: boolean; body: FaqRelease };

/** GET …/faq-release/current 的业务部分：locale 必填（en-GB | zh-CN，否则 400）。 */
export async function currentRelease(
  source: FaqReleaseSource,
  rawLocale: unknown,
  ifNoneMatch: string | undefined,
): Promise<CurrentReleaseResult> {
  if (!isHelpdeskLocale(rawLocale))
    throw new HelpdeskError(
      400,
      'INVALID_INPUT',
      'locale must be en-GB or zh-CN',
    );
  const release = await source.current();
  if (!release) return { kind: 'none' };
  const etag = faqReleaseEtag(release.version);
  return {
    kind: 'ok',
    etag,
    notModified: ifNoneMatchHits(ifNoneMatch, etag),
    body: publicRelease(release, rawLocale),
  };
}

/**
 * 把工作表冻结成快照（「发布新版本」）：只要已发布的节点（按 id 排序）；父节点已发布的边都要
 * （子节点归档 / 不在 → 图检查 edge_endpoint 拦下），同一父节点下按 position、创建时间、id
 * 重新编号为 0..n-1；问法只要已发布节点的（按 faqId、语言、文字排序）；流程树与对象表见 freezeMap。
 * 同样的工作表永远得到同样的快照（snapshotHash 相同），所以「没有改动」可以识别出来。
 */
export function freezeSnapshot(
  faqs: readonly HelpdeskFaq[],
  edges: readonly FaqEdgeRow[],
  phrasings: readonly Pick<FaqPhrasing, 'faqId' | 'locale' | 'text'>[],
  map: {
    nodes: readonly FaqMapNode[];
    placements: readonly Pick<FaqPlacement, 'faqId' | 'nodeId' | 'primary'>[];
  } = { nodes: [], placements: [] },
): FaqReleaseSnapshot {
  const published = faqs
    .filter((faq) => faq.status === 'published')
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(published.map((faq) => faq.id));
  const byParent = new Map<string, FaqEdgeRow[]>();
  for (const edge of edges) {
    if (!ids.has(edge.parentId)) continue;
    const list = byParent.get(edge.parentId) ?? [];
    list.push(edge);
    byParent.set(edge.parentId, list);
  }
  const frozenEdges: FaqSnapshotEdge[] = [];
  for (const parentId of [...byParent.keys()].sort()) {
    const ordered = byParent
      .get(parentId)!
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    ordered.forEach((edge, position) =>
      frozenEdges.push({
        parentId: edge.parentId,
        childId: edge.childId,
        kind: edge.kind,
        position,
        labelEn: edge.labelEn,
        labelZh: edge.labelZh,
      }),
    );
  }
  return {
    nodes: published.map((faq) =>
      freezeNode({
        id: faq.id,
        key: faq.key,
        type: faq.type,
        entry: faq.entry,
        category: faq.category,
        popular: faq.popular,
        questionEn: faq.questionEn,
        answerEn: faq.answerEn,
        questionZh: faq.questionZh,
        answerZh: faq.answerZh,
        signals: [...faq.signals],
        keywords: [...faq.keywords],
        version: faq.version,
        updatedAt: faq.updatedAt,
      }),
    ),
    edges: frozenEdges,
    phrasings: phrasings
      .filter((phrasing) => ids.has(phrasing.faqId))
      .map((phrasing) => ({
        faqId: phrasing.faqId,
        locale: phrasing.locale,
        text: phrasing.text,
      }))
      .sort(
        (a, b) =>
          a.faqId.localeCompare(b.faqId) ||
          a.locale.localeCompare(b.locale) ||
          a.text.localeCompare(b.text),
      ),
    ...frozenMap(freezeMap(map.nodes, map.placements, ids)),
  };
}

const frozenMap = (map: FaqSnapshotMap | undefined) => (map ? { map } : {});

/** 快照的内容指纹（SHA-256 hex）：同样的工作表 → 同样的指纹（「没有改动」、幂等新建）。 */
export function snapshotHash(snapshot: FaqReleaseSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/** 节点里参与差异比较的字段（块由答案决定、version / updatedAt 只是记账，不算改动）。 */
const DIFF_FIELDS = [
  'key',
  'type',
  'entry',
  'category',
  'popular',
  'questionEn',
  'answerEn',
  'questionZh',
  'answerZh',
  'signals',
  'keywords',
] as const satisfies readonly (keyof FaqSnapshotNode)[];

export type FaqDiffField = (typeof DIFF_FIELDS)[number];

export type FaqNodeRef = {
  id: string;
  key: string;
  questionEn: string;
  questionZh: string;
};

export type FaqSnapshotDiff = {
  nodes: {
    added: FaqNodeRef[];
    removed: FaqNodeRef[];
    changed: (FaqNodeRef & { fields: FaqDiffField[] })[];
  };
  edges: {
    added: FaqSnapshotEdge[];
    removed: FaqSnapshotEdge[];
    changed: {
      before: FaqSnapshotEdge;
      after: FaqSnapshotEdge;
      fields: ('kind' | 'position' | 'labelEn' | 'labelZh')[];
    }[];
  };
  phrasings: { added: number; removed: number };
  /** 流程树与对象表：节点（整行比较）与挂载各新增、去掉了几条。 */
  map: { added: number; removed: number };
  /** 什么都没变。 */
  same: boolean;
};

function ref(node: FaqSnapshotNode): FaqNodeRef {
  return {
    id: node.id,
    key: node.key,
    questionEn: node.questionEn,
    questionZh: node.questionZh,
  };
}

/** 两个快照的差异（base = 旧的，通常是当前发布的；head = 新的）；base 为 null = 全是新增。 */
export function diffSnapshots(
  base: FaqReleaseSnapshot | null,
  head: FaqReleaseSnapshot,
): FaqSnapshotDiff {
  const before = new Map((base?.nodes ?? []).map((node) => [node.id, node]));
  const after = new Map(head.nodes.map((node) => [node.id, node]));
  const nodes: FaqSnapshotDiff['nodes'] = {
    added: [],
    removed: [],
    changed: [],
  };
  for (const node of head.nodes) {
    const old = before.get(node.id);
    if (!old) {
      nodes.added.push(ref(node));
      continue;
    }
    const fields = DIFF_FIELDS.filter(
      (field) => JSON.stringify(old[field]) !== JSON.stringify(node[field]),
    );
    if (fields.length > 0) nodes.changed.push({ ...ref(node), fields });
  }
  for (const node of base?.nodes ?? [])
    if (!after.has(node.id)) nodes.removed.push(ref(node));

  const key = (edge: FaqSnapshotEdge) => `${edge.parentId}>${edge.childId}`;
  const oldEdges = new Map(
    (base?.edges ?? []).map((edge) => [key(edge), edge]),
  );
  const newEdges = new Map(head.edges.map((edge) => [key(edge), edge]));
  const edges: FaqSnapshotDiff['edges'] = {
    added: [],
    removed: [],
    changed: [],
  };
  for (const edge of head.edges) {
    const old = oldEdges.get(key(edge));
    if (!old) {
      edges.added.push(edge);
      continue;
    }
    const fields = (['kind', 'position', 'labelEn', 'labelZh'] as const).filter(
      (field) => old[field] !== edge[field],
    );
    if (fields.length > 0)
      edges.changed.push({ before: old, after: edge, fields });
  }
  for (const edge of base?.edges ?? [])
    if (!newEdges.has(key(edge))) edges.removed.push(edge);

  const phrasingKey = (p: FaqSnapshotPhrasing) =>
    `${p.faqId}\n${p.locale}\n${p.text.toLowerCase()}`;
  const oldPhrasings = new Set((base?.phrasings ?? []).map(phrasingKey));
  const newPhrasings = new Set(head.phrasings.map(phrasingKey));
  const phrasings = {
    added: [...newPhrasings].filter((k) => !oldPhrasings.has(k)).length,
    removed: [...oldPhrasings].filter((k) => !newPhrasings.has(k)).length,
  };
  const mapRows = (snapshot: FaqReleaseSnapshot | null) =>
    new Set([
      ...(snapshot?.map?.nodes ?? []).map((node) => JSON.stringify(node)),
      ...(snapshot?.map?.placements ?? []).map((p) => JSON.stringify(p)),
    ]);
  const oldMap = mapRows(base);
  const newMap = mapRows(head);
  const map = {
    added: [...newMap].filter((row) => !oldMap.has(row)).length,
    removed: [...oldMap].filter((row) => !newMap.has(row)).length,
  };
  return {
    nodes,
    edges,
    phrasings,
    map,
    same:
      nodes.added.length +
        nodes.removed.length +
        nodes.changed.length +
        edges.added.length +
        edges.removed.length +
        edges.changed.length +
        phrasings.added +
        phrasings.removed +
        map.added +
        map.removed ===
      0,
  };
}
