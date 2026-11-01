import {
  noGapLabeller,
  type GapLabel,
  type GapLabeller,
  type GapLabelSkip,
} from '../../../../contracts/helpdesk-flywheel';
import { INSIGHT_LIMITS } from '../contracts';
import type { FaqGraphRepository } from '../faqs/faqGraphRepository';
import {
  HelpdeskError,
  type PortalHelpdeskClient,
} from '../portalHelpdeskClient';
import type { CandidateRepository } from './candidateRepository';
import {
  MINING_LIMITS,
  codeLabel,
  dominant,
  mineable,
  miningTurn,
  planMining,
  type CandidateExample,
  type NodeText,
} from './flywheelMining';
import type { InsightRepository } from './insightRepository';
import { createNgramSimilarity, type TextSimilarity } from './textSimilarity';

/**
 * 每晚的数据飞轮（v5 Part G3）：
 * 1. 拉：从 Portal 的 insights（脱敏的轮 + 标签，契约 fixture v7）拉到 Admin 的事实表，
 *    从事实表里最新的一轮往回 72 小时开始（让投票、评分落定；按轮 id 幂等 upsert），
 *    空表从 30 天前开始；一晚至多 200 页（每页 500 轮），没拉完 → moreDue，下一次接着拉。
 *    工单结果落定得更晚（工单在聊天后 24 小时内建，客服处理，再等至多 72 小时自动确认）：再补拉
 *    一段更早的——从最近 14 天里结果还可能变的最早一轮（有工单没关的，或还没在它之后满 24 小时
 *    看过的）到上面的起点（until），至多 100 页，与往前拉互不耽误。
 *    Portal 没接上（没配地址或令牌）→ 跳过拉取、照样挖（本地开发）；Portal 出错 → 照样挖已有的，
 *    这次运行记失败（调度器会重试）。
 * 2. 挖：最近 30 天、AI 没解决、值得挖、还没归属的轮（最新的 2000 轮）→ 计划（flywheelMining.ts）→
 *    并进已有候选 / 建新候选。新候选一组一次模型调用（GapLabeller：话题 + 一个学员口吻的问题 + 分类），
 *    大组先，一晚至多 30 次、至多 0.10 美元；模型关着、超预算、失败或没过守卫 → 代码写的标签。
 * 和已发布节点去重用工作表里已发布的节点（问题与问法），所以员工刚接受、还没发版的也算。
 * 挖完再按成员轮的最新结果刷新待处理候选的草稿来源与原因构成（工单后来解决了 → 起草有了来源）。
 */
export const PULL_LIMITS = {
  lookbackMs: 72 * 3_600_000,
  firstPullMs: 30 * 24 * 3_600_000,
  pageSize: INSIGHT_LIMITS.pageMax,
  pagesMax: 200,
  /** 补拉工单结果：最多往回看这么久，一晚至多这么多页。 */
  outcomeWindowMs: 14 * 24 * 3_600_000,
  refreshPagesMax: 100,
} as const;

export type RefreshStats = {
  since: string | null;
  pages: number;
  received: number;
  inserted: number;
  updated: number;
  moreDue: boolean;
};

export type PullStats = {
  status: 'pulled' | 'not_connected' | 'failed';
  since: string | null;
  until: string | null;
  pages: number;
  received: number;
  inserted: number;
  updated: number;
  moreDue: boolean;
  errorCode: string | null;
  refresh: RefreshStats;
};

export type MineStats = {
  considered: number;
  mineable: number;
  groups: number;
  created: number;
  grown: number;
  turnsAdded: number;
  singles: number;
  modelCalls: number;
  modelLabels: number;
  codeLabels: number;
  modelSkipped: Partial<Record<GapLabelSkip, number>>;
  costUsd: number;
  /** 按成员轮的最新结果刷新了草稿来源或原因构成的待处理候选。 */
  refreshed: number;
};

/** 工作表里已发布的节点的问题与问法（answer 节点；choice 节点不陈述事实，不当去重目标）。 */
export async function workingNodeTexts(
  graph: Pick<FaqGraphRepository, 'working'>,
): Promise<NodeText[]> {
  const { faqs, phrasings } = await graph.working();
  const answers = new Set(
    faqs.filter((faq) => faq.type === 'answer').map((faq) => faq.id),
  );
  return [
    ...faqs
      .filter((faq) => answers.has(faq.id))
      .flatMap((faq) => [
        { nodeId: faq.id, text: faq.questionEn },
        { nodeId: faq.id, text: faq.questionZh },
      ]),
    ...phrasings
      .filter((p) => answers.has(p.faqId))
      .map((p) => ({ nodeId: p.faqId, text: p.text })),
  ];
}

/** 失败的运行带着计数抛出（运行行照样记下计数）。 */
export class FlywheelRunError extends Error {
  constructor(
    readonly code: string,
    readonly stats: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'FlywheelRunError';
  }
}

export type FlywheelServiceDeps = {
  portal: Pick<PortalHelpdeskClient, 'insights'>;
  insights: InsightRepository;
  candidates: CandidateRepository;
  nodes: () => Promise<NodeText[]>;
  labeller?: GapLabeller;
  similarity?: TextSimilarity<unknown>;
  now?: () => Date;
};

/** 例句里最多的语言（给模型的提示）。 */
function exampleLocale(examples: readonly CandidateExample[]) {
  return (
    (dominant(
      examples.map((e) => e.locale),
      0,
    ) as CandidateExample['locale'] | null) ?? 'zh-CN'
  );
}

export function createFlywheelService(deps: FlywheelServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const labeller = deps.labeller ?? noGapLabeller;
  const similarity = deps.similarity ?? createNgramSimilarity();

  /** 一段时间的所有页 → 事实表（至多 pagesMax 页）。 */
  async function pullWindow(
    window: { since: string; until?: string },
    pagesMax: number,
    into: {
      pages: number;
      received: number;
      inserted: number;
      updated: number;
      moreDue: boolean;
    },
  ): Promise<string | null> {
    let cursor: string | undefined;
    let until: string | null = null;
    for (;;) {
      const page = await deps.portal.insights({
        since: window.since,
        ...(window.until ? { until: window.until } : {}),
        limit: PULL_LIMITS.pageSize,
        ...(cursor ? { cursor } : {}),
      });
      into.pages += 1;
      until = page.until;
      into.received += page.turns.length;
      const written = await deps.insights.upsertTurns(page.turns);
      into.inserted += written.inserted;
      into.updated += written.updated;
      if (!page.nextCursor) break;
      if (into.pages >= pagesMax) {
        into.moreDue = true;
        break;
      }
      cursor = page.nextCursor;
    }
    return until;
  }

  async function pull(): Promise<PullStats> {
    const latest = await deps.insights.latestTurnAt();
    const at = now().getTime();
    const since = new Date(
      latest
        ? Math.min(Date.parse(latest), at) - PULL_LIMITS.lookbackMs
        : at - PULL_LIMITS.firstPullMs,
    ).toISOString();
    const refresh: RefreshStats = {
      since: null,
      pages: 0,
      received: 0,
      inserted: 0,
      updated: 0,
      moreDue: false,
    };
    const stats: PullStats = {
      status: 'pulled',
      since,
      until: null,
      pages: 0,
      received: 0,
      inserted: 0,
      updated: 0,
      moreDue: false,
      errorCode: null,
      refresh,
    };
    try {
      stats.until = await pullWindow({ since }, PULL_LIMITS.pagesMax, stats);
      // 更早的、工单结果还可能变的轮：补拉到 since 为止（只在空表之外）
      const open = latest
        ? await deps.insights.earliestOpenOutcome(
            new Date(at - PULL_LIMITS.outcomeWindowMs).toISOString(),
          )
        : null;
      if (open && open < since) {
        refresh.since = open;
        await pullWindow(
          { since: open, until: since },
          PULL_LIMITS.refreshPagesMax,
          refresh,
        );
      }
    } catch (error) {
      if (
        error instanceof HelpdeskError &&
        error.code === 'HELPDESK_NOT_CONNECTED' &&
        stats.pages === 0
      )
        return { ...stats, status: 'not_connected' };
      return {
        ...stats,
        status: 'failed',
        errorCode: error instanceof HelpdeskError ? error.code : 'PULL_FAILED',
      };
    }
    return stats;
  }

  async function mine(): Promise<MineStats> {
    const at = now().getTime();
    const day = 24 * 3_600_000;
    const rows = await deps.insights.unassignedUnsolved({
      since: new Date(at - MINING_LIMITS.windowDays * day).toISOString(),
      limit: MINING_LIMITS.turnsMax,
    });
    const turns = rows.map(miningTurn).filter(mineable);
    const [open, nodes] = await Promise.all([
      deps.candidates.openCandidates(
        new Date(at - MINING_LIMITS.candidatesWindowDays * day).toISOString(),
      ),
      deps.nodes(),
    ]);
    const plan = await planMining({
      turns,
      nodes,
      candidates: open,
      similarity,
    });
    const stats: MineStats = {
      considered: rows.length,
      mineable: turns.length,
      groups: plan.create.length,
      created: 0,
      grown: 0,
      turnsAdded: 0,
      singles: plan.singles,
      modelCalls: 0,
      modelLabels: 0,
      codeLabels: 0,
      modelSkipped: {},
      costUsd: 0,
      refreshed: 0,
    };
    for (const growth of plan.grow) {
      const grown = await deps.candidates.growCandidate(
        growth.candidateId,
        growth.members,
      );
      if (grown && grown.added > 0) {
        stats.grown += 1;
        stats.turnsAdded += grown.added;
      }
    }
    let modelOff = false;
    const skip = (reason: GapLabelSkip) => {
      stats.modelSkipped[reason] = (stats.modelSkipped[reason] ?? 0) + 1;
    };
    for (const group of plan.create) {
      let label: GapLabel | null = null;
      if (modelOff) skip('disabled');
      else if (
        stats.modelCalls >= MINING_LIMITS.labelCallsMax ||
        stats.costUsd >= MINING_LIMITS.labelCostMaxUsd
      )
        skip('budget');
      else {
        const result = await labeller.label({
          locale: exampleLocale(group.examples),
          examples: group.examples.map((e) => e.text),
        });
        if (result.ok || result.reason !== 'disabled') stats.modelCalls += 1;
        stats.costUsd += result.costUsd ?? 0;
        if (result.ok) label = result.label;
        else {
          skip(result.reason);
          if (result.reason === 'disabled') modelOff = true;
        }
      }
      const fallback = codeLabel(group.examples);
      const candidate = await deps.candidates.insertCandidate(
        {
          suggestion: group.suggestion,
          origin: 'mining',
          topic: label?.topic ?? fallback.topic,
          proposedQuestion: label?.question ?? fallback.question,
          labelSource: label ? 'model' : 'code',
          category: label?.category ?? null,
          locale: group.locale,
          examples: group.examples,
          sourceMix: group.sourceMix,
          answerSources: group.answerSources,
          relatedNodeId: group.relatedNodeId,
          relatedScore: group.relatedScore,
          parentNodeId: group.parentNodeId,
          shownNodeId: group.shownNodeId,
          ticketId: null,
          firstSeenAt: group.firstSeenAt,
          lastSeenAt: group.lastSeenAt,
          createdBy: null,
        },
        group.members,
      );
      if (candidate) {
        stats.created += 1;
        stats.turnsAdded += candidate.turnCount;
        if (label) stats.modelLabels += 1;
        else stats.codeLabels += 1;
      }
    }
    stats.costUsd = Math.round(stats.costUsd * 1e6) / 1e6;
    stats.refreshed = await deps.candidates.refreshOpenFromMembers();
    return stats;
  }

  return {
    pull,
    mine,

    /** 每晚的一次：拉 → 挖。拉取失败照样挖，但整次记失败（计数照记），调度器会重试。 */
    async nightly(): Promise<{
      stats: Record<string, unknown>;
      moreDue: boolean;
    }> {
      const pulled = await pull();
      const mined = await mine();
      const stats = { pull: pulled, mine: mined };
      if (pulled.status === 'failed')
        throw new FlywheelRunError(pulled.errorCode ?? 'PULL_FAILED', stats);
      return { stats, moreDue: pulled.moreDue };
    },
  };
}

export type FlywheelService = ReturnType<typeof createFlywheelService>;
