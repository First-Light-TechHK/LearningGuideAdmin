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
