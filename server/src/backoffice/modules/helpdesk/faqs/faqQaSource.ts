import {
  isHelpdeskLocale,
  type FaqBlock,
  type FaqEdgeKind,
  type HelpdeskLocale,
  type HelpdeskQaCandidate,
  type HelpdeskQaSource,
} from '../../../../contracts/helpdesk-qa';
import { splitAnswerBlocks } from './faqBlocks';
import { FAQ_LIMITS, localised, type HelpdeskFaq } from './faqContracts';
import { createPgFaqGraphRepository } from './faqGraphRepository';
import {
  createPgFaqRepository,
  type FaqRepository,
  type ScoredFaq,
  type SqlDb,
} from './faqRepository';
import { locatorHead, locatorIndex, type FaqSnapshotMap } from './faqMap';
import type { FaqReleaseSource, FaqSnapshotNode } from './faqRelease';
import { createPgFaqReleaseSource } from './faqReleaseService';
import {
  createEnvFaqVectorSearch,
  logFaqVectorSearchError,
  retrievalMode,
  warmFaqVectors,
  withFaqVectorSearch,
  type FaqVectorSearch,
} from './faqVectors';

/**
 * Agent 用的已发布 FAQ 来源（契约 HelpdeskQaSource 的实现；由 app.module.ts 交给 AiModule）。
 *
 * 唯一的开关（helpdesk-v5-faq-graph-design §2.2）：有发布版本 → 只读那一版快照（检索走
 * helpdesk_faq_release_nodes，节点、块、边来自快照），从不读工作表；还没有任何发布版本 →
 * 照旧读逐条发布的行（边读工作表）。员工改了工作表，学员看到的要等下一次发布。
 *
 * 屏幕上有卡片（search.nodeId）时：先是它的全部子节点（命中的按得分在前，再按边的顺序），
 * 再是树上近亲（父节点的其它子节点、各层祖先、祖先的其它子节点）里命中的，最后是普通检索（入口节点）；
 * 调用方给了 deepReserved 时，命中的非入口 answer 节点另留几个位置。按 id 去重，至多 limit 条。
 *
 * 定位方式（HELPDESK_LOCATOR，设计文档「Helpdesk 定位方式对比」）：缺省 flat = 上面这些；hybrid =
 * 屏幕上没有卡片、发布版本里有流程树与对象表时，结构排序的前 3 张（faqMap.ts locatorHead）放在最前面，
 * 后面照旧是上面的候选（去重），所以至多 limit + 3 条、上面的一张不少。
 */

/** 运行时需要的边（发布版本里来自快照，之前来自工作表）。 */
export type QaEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
};

export type HelpdeskQaSourceDeps = {
  repository?: FaqRepository;
  /** 已发布快照（带缓存）；没有发布版本 → current() 返回 null。 */
  releases: FaqReleaseSource;
  /** 第一版发布之前：工作表上的边。 */
  liveEdges: () => Promise<QaEdge[]>;
  /** 定位方式（每次现读；缺省 flat）。 */
  locator?: () => LocatorMode;
};

export const LOCATOR_MODES = ['flat', 'hybrid'] as const;
export type LocatorMode = (typeof LOCATOR_MODES)[number];

export function locatorMode(env: NodeJS.ProcessEnv): LocatorMode {
  return env.HELPDESK_LOCATOR?.trim().toLowerCase() === 'hybrid'
    ? 'hybrid'
    : 'flat';
}

type View = {
  release: number | null;
  edges: QaEdge[];
  /** 发布版本里的节点（块是冻结时切好的）；live 时为空。 */
  nodes: Map<string, FaqSnapshotNode>;
  /** 发布版本里的流程树与对象表（没有 → undefined）。 */
  map?: FaqSnapshotMap;
};

/**
 * 屏幕上有卡片时的候选配额：没有检索命中的子节点至多取前 4 个（Portal 至多显示 4 个追问 / 选项），
 * 普通检索至少留 4 个位置（学员换了话题时，新问题的答案还在候选里）。
 */
export const CANDIDATE_NEAR = {
  unscoredChildrenMax: 4,
  searchReserved: 4,
} as const;

function blocksOf(
  faq: Pick<HelpdeskFaq, 'id' | 'type'>,
  answer: string,
  locale: HelpdeskLocale,
  view: View,
): FaqBlock[] {
  if (faq.type !== 'answer') return [];
  const frozen = view.nodes.get(faq.id);
  if (frozen) return locale === 'zh-CN' ? frozen.blocksZh : frozen.blocksEn;
  return splitAnswerBlocks(answer);
}

export function createHelpdeskQaSource(
  deps: HelpdeskQaSourceDeps,
): HelpdeskQaSource {
  const repository = deps.repository ?? createPgFaqRepository();

  async function view(withEdges: boolean): Promise<View> {
    const current = await deps.releases.current();
    if (current)
      return {
        release: current.version,
        edges: current.snapshot.edges,
        nodes: new Map(current.snapshot.nodes.map((node) => [node.id, node])),
        map: current.snapshot.map,
      };
    return {
      release: null,
      edges: withEdges ? await deps.liveEdges() : [],
      nodes: new Map(),
    };
  }

  function candidate(
    faq: HelpdeskFaq,
    score: number,
    locale: HelpdeskLocale,
    v: View,
    relation: HelpdeskQaCandidate['relation'],
  ): HelpdeskQaCandidate {
    const text = localised(faq, locale);
    return {
      id: faq.id,
      category: faq.category,
      ...text,
      score,
      type: faq.type,
      entry: faq.entry,
      blocks: blocksOf(faq, text.answer, locale, v),
      optionOf: v.edges
        .filter((edge) => edge.kind === 'option' && edge.childId === faq.id)
        .map((edge) => edge.parentId),
      relation,
    };
  }

  return {
    async releaseVersion() {
      return (await deps.releases.current())?.version ?? null;
    },

    async findCandidates(search) {
      if (!isHelpdeskLocale(search.locale)) return [];
      const locale = search.locale;
      const limit = Math.min(search.limit, FAQ_LIMITS.candidatesMax);
      const v = await view(true);
      const contextId = search.nodeId?.toLowerCase();
      const children = contextId
        ? v.edges
            .filter((edge) => edge.parentId === contextId)
            .sort((a, b) => a.position - b.position)
        : [];
      // 树上近亲：从屏幕上的卡片往上走，每层祖先本身和它的其它子节点（真模型评测离线回放 2026-10-30：
      // 往下走了两层的用户回头问祖父节点的另一个追问、或回到父节点，这些卡片既不是入口也不是兄弟）
      const relatives = new Set<string>();
      if (contextId) {
        const visited = new Set<string>();
        const queue = v.edges
          .filter((edge) => edge.childId === contextId)
          .map((edge) => edge.parentId);
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (visited.has(id)) continue;
          visited.add(id);
          relatives.add(id);
          for (const edge of v.edges) {
            if (edge.parentId === id) relatives.add(edge.childId);
            if (edge.childId === id) queue.push(edge.parentId);
          }
        }
        relatives.delete(contextId);
      }
      const entryOnly = search.entryOnly ?? true;
      const types = search.types ?? ['answer'];
      const deepWanted =
        entryOnly && types.includes('answer')
          ? Math.max(0, Math.min(search.deepReserved ?? 0, limit))
          : 0;
      // 子节点 / 近亲 / 深层答案可能不是入口、可能是 choice：先不限，下面再按调用方要的过滤普通检索
      const wide = children.length > 0 || relatives.size > 0 || deepWanted > 0;

      const searched = await repository.searchPublished({
        locale,
        boost: search.category,
        text: search.text,
        limit: wide ? FAQ_LIMITS.publicLimitMax : limit,
        release: v.release,
        ...(wide
          ? {
              entryOnly: false,
              types:
                contextId !== undefined
                  ? (['answer', 'choice'] as const)
                  : search.types,
            }
          : { entryOnly: search.entryOnly, types: search.types }),
      });
      const scored = new Map<string, ScoredFaq>(
        searched.map((faq) => [faq.id, faq]),
      );

      // 先排好子节点与检索两队，再合并：
      // - 子节点：有检索命中的按分数在前（不管第几个）；没命中的只取学员看得到的前 4 个（Portal 至多 4 个
      //   追问 chip / 选项），免得 6 个零分的追问挤掉换了话题的新问题；
      // - 检索队：有命中的兄弟节点与普通检索按分数排在一起（同分兄弟在前）。兄弟节点本来就是检索命中，
      //   单独排队会被零分的子节点和留给检索的 4 个位置挤掉，最好的那条反而到不了模型（真模型评测
      //   2026-10-30：看着「退款」问「怎么取消订阅」）；
      // - 检索队至少留 4 个位置（不够 4 个时子节点补满）。
      const nearList: {
        faq: HelpdeskFaq;
        score: number;
        relation: 'child';
      }[] = [];
      if (children.length > 0) {
        const rows = await Promise.all(
          children.map(
            async (edge) =>
              scored.get(edge.childId) ??
              (await repository.getPublished(edge.childId, {
                release: v.release,
              })),
          ),
        );
        rows
          .map((faq, index) => ({
            faq,
            index,
            score: faq ? (scored.get(faq.id)?.score ?? 0) : 0,
          }))
          .filter(
            ({ faq, index }) =>
              faq !== null &&
              (scored.has(faq.id) ||
                index < CANDIDATE_NEAR.unscoredChildrenMax),
          )
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .forEach(({ faq, score }) =>
            nearList.push({
              faq: faq as HelpdeskFaq,
              score,
              relation: 'child',
            }),
          );
      }
      const nearIds = new Set(nearList.map((item) => item.faq.id));
      type Queued = {
        faq: HelpdeskFaq;
        score: number;
        relation: 'sibling' | 'search';
        index: number;
      };
      const searchList: Queued[] = [];
      // 检索命中的非入口 answer 节点（按得分），至多占 deepWanted 个位置
      const deepList: Queued[] = [];
      searched.forEach((faq, index) => {
        if (nearIds.has(faq.id)) return;
        if (relatives.has(faq.id))
          searchList.push({
            faq,
            score: faq.score,
            relation: 'sibling',
            index,
          });
        else if (wide && entryOnly && !faq.entry) {
          if (deepWanted > 0 && faq.type === 'answer')
            deepList.push({ faq, score: faq.score, relation: 'search', index });
        } else if (!(wide && !types.includes(faq.type)))
          searchList.push({ faq, score: faq.score, relation: 'search', index });
      });
      searchList.sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.relation === 'sibling') - Number(a.relation === 'sibling') ||
          a.index - b.index,
      );

      const out: HelpdeskQaCandidate[] = [];
      const taken = new Set<string>();
      const push = (
        faq: HelpdeskFaq,
        score: number,
        relation: HelpdeskQaCandidate['relation'],
      ) => {
        if (taken.has(faq.id) || out.length >= limit) return;
        taken.add(faq.id);
        out.push(candidate(faq, score, locale, v, relation));
      };
      // 顺序：子节点（让出检索与深层答案的位置）→ 检索队（让出深层答案的位置）→ 深层答案 → 余下的检索 → 余下的子节点
      const deepRoom = Math.min(deepWanted, deepList.length);
      const reserved = Math.min(
        CANDIDATE_NEAR.searchReserved,
        searchList.length,
      );
      const nearRoom = Math.max(0, limit - reserved - deepRoom);
      nearList
        .slice(0, nearRoom)
        .forEach((item) => push(item.faq, item.score, item.relation));
      for (const item of searchList)
        if (out.length < limit - deepRoom)
          push(item.faq, item.score, item.relation);
      deepList
        .slice(0, deepRoom)
        .forEach((item) => push(item.faq, item.score, item.relation));
      for (const item of searchList) push(item.faq, item.score, item.relation);
      nearList
        .slice(nearRoom)
        .forEach((item) => push(item.faq, item.score, item.relation));

      // hybrid：结构排序的前几张放最前面（只在换话题 / 第一句、并且拿到了全部命中时）
      if (
        (deps.locator?.() ?? 'flat') === 'hybrid' &&
        !contextId &&
        deepWanted > 0 &&
        v.map
      ) {
        const head = locatorHead({
          index: locatorIndex(v.map),
          text: search.text,
          scored: searched,
          flatTop: out.map((c) => c.id),
        }).flatMap((id) => {
          const faq = scored.get(id);
          return faq ? [candidate(faq, faq.score, locale, v, 'search')] : [];
        });
        const ids = new Set(head.map((c) => c.id));
        return [...head, ...out.filter((c) => !ids.has(c.id))];
      }
      return out;
    },

    async findPopular(search) {
      if (!isHelpdeskLocale(search.locale)) return [];
      const locale = search.locale;
      const v = await view(false);
      const found = await repository.listPublished({
        popular: true,
        boost: search.category,
        excludeIds: search.excludeIds,
        limit: Math.min(search.limit, FAQ_LIMITS.candidatesMax),
        release: v.release,
      });
      return found.map((faq) => candidate(faq, 0, locale, v, 'search'));
    },

    async findPublished(id, locale) {
      if (!isHelpdeskLocale(locale)) return null;
      const v = await view(true);
      const faq = await repository.getPublished(id.toLowerCase(), {
        release: v.release,
      });
      return faq ? candidate(faq, 0, locale, v, 'search') : null;
    },
  };
}

/**
 * 生产组装（app.module.ts）：同一个库读检索、发布版本与边。评测（eval/helpdesk）给自己的 SqlDb。
 */
export function createPgHelpdeskQaSource(
  repository?: FaqRepository,
  db?: SqlDb,
  vectors: FaqVectorSearch = createEnvFaqVectorSearch(db),
): HelpdeskQaSource {
  const graph = createPgFaqGraphRepository(db);
  const source = createHelpdeskQaSource({
    // 候选检索按 HELPDESK_RETRIEVAL（每次现读，缺省 lexical = 和以前一样只走字词）
    repository: withFaqVectorSearch(repository ?? createPgFaqRepository(db), {
      vectors,
      mode: () => retrievalMode(process.env),
      onError: logFaqVectorSearchError,
    }),
    releases: createPgFaqReleaseSource(graph),
    liveEdges: () => graph.allEdges(),
    locator: () => locatorMode(process.env),
  });
  // 向量检索开着时，启动就把上线版本的向量读进内存（约 1 秒），免得最先几个提问等不到、退回字词检索
  if (retrievalMode(process.env) !== 'lexical')
    void warmFaqVectors(
      vectors,
      () => source.releaseVersion?.() ?? Promise.resolve(null),
    );
  return source;
}
