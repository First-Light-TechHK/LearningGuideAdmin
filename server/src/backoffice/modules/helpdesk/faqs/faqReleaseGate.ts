import type { FaqRepository } from './faqRepository';
import type { FaqReleaseSnapshot } from './faqRelease';

/**
 * 发布前的评测门（helpdesk-v5-faq-graph-design §2.2「发布新版本」、v5 Part G5）：新建版本时，
 * 快照与它的检索行已经写好，发布流程调用 FaqReleaseGate.evaluate；只有 passed 的版本才能发布。
 *
 * 缺省是免费的、只跑检索的评测（不问模型、不花钱）：对快照里每个入口 answer 节点，用它的
 * 英文问题、中文问题与每一种问法去检索那一版快照（与生产同一条候选 SQL），看它是否在前 8 名
 * （recall@8）。门槛：recall@8 ≥ 95%，且比上一个发布版本的 recall@8 低不超过 1 个百分点。
 * 真模型的评测（花钱）在开关后面：HELPDESK_RELEASE_MODEL_EVAL=on 且组装时给了 model 门才跑；
 * 开关开着却没给 model 门 → 不通过（不会悄悄跳过）。测试里永远关着。
 */

export type FaqReleaseEvalCase = {
  nodeId: string;
  key: string;
  /** 检索用的语言（zh-TW 的问法按 zh-CN 检索，与学员的繁体原文一样）。 */
  locale: 'en-GB' | 'zh-CN';
  /** regression：员工从数据飞轮接受的一组学员原话（脱敏过），标着选定的节点（v5 Part G5）。 */
  source: 'question' | 'phrasing' | 'regression';
  text: string;
};

/** 回归用例（helpdesk_faq_eval_cases）：节点、语言与脱敏过的学员原话。 */
export type FaqRegressionCase = {
  faqId: string;
  locale: 'en-GB' | 'zh-CN' | 'zh-TW';
  text: string;
};

export type FaqReleaseEvalMiss = FaqReleaseEvalCase & { rank: number | null };

export type FaqReleaseEvalReport = {
  kind: 'retrieval' | 'model' | 'combined' | 'rollback' | 'skipped';
  passed: boolean;
  /** 一句话（英文；界面另有本地化文字）。 */
  summary: string;
  ranAt: string;
  metrics: Record<string, number>;
  /** 没过的用例（至多 50 条）。 */
  misses: FaqReleaseEvalMiss[];
  parts?: FaqReleaseEvalReport[];
  /**
   * 评测时对比的上线版本（服务层写入；当时没有上线的 → null）。现在上线的不是它 → 要重新检查才能发布。
   * 早于这个字段的报告没有它（不比较）。
   */
  baselineVersion?: number | null;
  /** 回滚：快照复制自哪个版本（那一版当时的报告在 sourceReport）。 */
  sourceVersion?: number;
  sourceReport?: unknown;
};

export type FaqReleaseGateInput = {
  version: number;
  snapshot: FaqReleaseSnapshot;
  /** 当前发布的那一版（比较 recall 用）；没有 → null。 */
  previous: { version: number; evalReport: unknown } | null;
};

export interface FaqReleaseGate {
  evaluate(input: FaqReleaseGateInput): Promise<FaqReleaseEvalReport>;
}

export const RETRIEVAL_GATE = {
  recallAt8Min: 0.95,
  /** 比上一版低多少以内算没退步（1 个百分点）。 */
  recallDropMax: 0.01,
  topK: 8,
  missesMax: 50,
  concurrency: 4,
} as const;

/** 快照 → 检索用例：入口 answer 节点的两种语言的问题与每一种问法。 */
export function releaseEvalCases(
  snapshot: FaqReleaseSnapshot,
): FaqReleaseEvalCase[] {
  const entries = snapshot.nodes.filter(
    (node) => node.entry && node.type === 'answer',
  );
  const ids = new Set(entries.map((node) => node.id));
  const keys = new Map(entries.map((node) => [node.id, node.key]));
  const cases: FaqReleaseEvalCase[] = [];
  for (const node of entries) {
    cases.push(
      {
        nodeId: node.id,
        key: node.key,
        locale: 'en-GB',
        source: 'question',
        text: node.questionEn,
      },
      {
        nodeId: node.id,
        key: node.key,
        locale: 'zh-CN',
        source: 'question',
        text: node.questionZh,
      },
    );
  }
  for (const phrasing of snapshot.phrasings)
    if (ids.has(phrasing.faqId))
      cases.push({
        nodeId: phrasing.faqId,
        key: keys.get(phrasing.faqId)!,
        locale: phrasing.locale === 'en-GB' ? 'en-GB' : 'zh-CN',
        source: 'phrasing',
        text: phrasing.text,
      });
  return cases;
}

type StoredReport = {
  kind?: string;
  metrics?: Record<string, number>;
  parts?: unknown[];
  sourceReport?: unknown;
};

/**
 * 上一版的 recall@8：检索报告（或组合报告里的检索部分）；回滚上线的版本自己没有指标，
 * 跟着 sourceReport 找回滚来源当时的报告（回滚可以套回滚，最多跟 10 层）。
 */
function recallOf(raw: unknown, depth = 0): number | null {
  const report = raw as StoredReport | null | undefined;
  if (!report || typeof report !== 'object' || depth > 10) return null;
  const all = [report, ...((report.parts ?? []) as StoredReport[])];
  for (const part of all)
    if (
      part?.kind === 'retrieval' &&
      typeof part.metrics?.recallAt8 === 'number'
    )
      return part.metrics.recallAt8;
  if (report.kind === 'rollback')
    return recallOf(report.sourceReport, depth + 1);
  return null;
}

function previousRecall(
  previous: FaqReleaseGateInput['previous'],
): number | null {
  return recallOf(previous?.evalReport);
}

/**
 * 回归用例 → 检索用例：只算这一版里检索得到的节点（入口 answer）；别的（节点归档了、不是入口）跳过，
 * 计在 regressionSkipped 里（不算错：那条路径由问题树检查管）。
 */
export function regressionEvalCases(
  snapshot: FaqReleaseSnapshot,
  regression: readonly FaqRegressionCase[],
): { cases: FaqReleaseEvalCase[]; skipped: number } {
  const keys = new Map(
    snapshot.nodes
      .filter((node) => node.entry && node.type === 'answer')
      .map((node) => [node.id, node.key]),
  );
  const cases: FaqReleaseEvalCase[] = [];
  let skipped = 0;
  for (const item of regression) {
    const key = keys.get(item.faqId);
    if (!key) {
      skipped += 1;
      continue;
    }
    cases.push({
      nodeId: item.faqId,
      key,
      locale: item.locale === 'en-GB' ? 'en-GB' : 'zh-CN',
      source: 'regression',
      text: item.text,
    });
  }
  return { cases, skipped };
}

/**
 * 免费的检索评测门：用生产的候选 SQL 检索那一版快照（release = version）。regressionCases 给了时，
 * 员工从数据飞轮接受过的学员原话也一起评测（v5 Part G5）。
 */
export function createRetrievalGate(
  repository: Pick<FaqRepository, 'searchPublished'>,
  now: () => Date = () => new Date(),
  options: { regressionCases?: () => Promise<FaqRegressionCase[]> } = {},
): FaqReleaseGate {
  return {
    async evaluate({ version, snapshot, previous }) {
      const regression = options.regressionCases
        ? regressionEvalCases(snapshot, await options.regressionCases())
        : null;
      const cases = [
        ...releaseEvalCases(snapshot),
        ...(regression?.cases ?? []),
      ];
      const ranks: (number | null)[] = new Array<number | null>(cases.length);
      let next = 0;
      const worker = async () => {
        while (next < cases.length) {
          const index = next++;
          const item = cases[index];
          const found = await repository.searchPublished({
            locale: item.locale,
            boost: null,
            text: item.text,
            limit: RETRIEVAL_GATE.topK,
            release: version,
          });
          const at = found.findIndex((faq) => faq.id === item.nodeId);
          ranks[index] = at < 0 ? null : at + 1;
        }
      };
      await Promise.all(
        Array.from({ length: RETRIEVAL_GATE.concurrency }, worker),
      );
      const total = cases.length;
      const hits8 = ranks.filter((rank) => rank !== null).length;
      const hits1 = ranks.filter((rank) => rank === 1).length;
      const recallAt8 = total === 0 ? 1 : hits8 / total;
      const recallAt1 = total === 0 ? 1 : hits1 / total;
      const before = previousRecall(previous);
      const reasons: string[] = [];
      // 一个入口答案都没有（误把 FAQ 全归档了）：Portal 会没有 chip、没有答案，不能发布
      if (total === 0) reasons.push('the release has no entry answers');
      if (recallAt8 < RETRIEVAL_GATE.recallAt8Min)
        reasons.push(
          `recall@8 ${(recallAt8 * 100).toFixed(1)}% < ${RETRIEVAL_GATE.recallAt8Min * 100}%`,
        );
      if (before !== null && recallAt8 < before - RETRIEVAL_GATE.recallDropMax)
        reasons.push(
          `recall@8 dropped from ${(before * 100).toFixed(1)}% (v${previous!.version}) to ${(recallAt8 * 100).toFixed(1)}%`,
        );
      const misses = cases
        .map((item, index) => ({ ...item, rank: ranks[index] }))
        .filter((item) => item.rank === null)
        .slice(0, RETRIEVAL_GATE.missesMax);
      return {
        kind: 'retrieval',
        passed: reasons.length === 0,
        summary:
          reasons.length === 0
            ? `Retrieval eval passed: recall@8 ${(recallAt8 * 100).toFixed(1)}% over ${total} cases`
            : `Retrieval eval failed: ${reasons.join('; ')}`,
        ranAt: now().toISOString(),
        metrics: {
          cases: total,
          recallAt1: Number(recallAt1.toFixed(4)),
          recallAt8: Number(recallAt8.toFixed(4)),
          ...(before === null ? {} : { previousRecallAt8: before }),
          ...(regression
            ? {
                regressionCases: regression.cases.length,
                regressionSkipped: regression.skipped,
              }
            : {}),
        },
        misses,
      };
    },
  };
}

/**
 * 组装评测门：检索评测永远跑；真模型评测只在 modelEnabled 时跑（缺省读 HELPDESK_RELEASE_MODEL_EVAL）。
 * 两个都跑时，两个都过才算过。
 */
export function createFaqReleaseGate(options: {
  retrieval: FaqReleaseGate;
  model?: FaqReleaseGate;
  modelEnabled?: boolean;
  now?: () => Date;
}): FaqReleaseGate {
  const enabled =
    options.modelEnabled ?? process.env.HELPDESK_RELEASE_MODEL_EVAL === 'on';
  const now = options.now ?? (() => new Date());
  return {
    async evaluate(input) {
      const retrieval = await options.retrieval.evaluate(input);
      if (!enabled) return retrieval;
      const model: FaqReleaseEvalReport = options.model
        ? await options.model.evaluate(input)
        : {
            kind: 'model',
            passed: false,
            summary:
              'The model eval is switched on (HELPDESK_RELEASE_MODEL_EVAL=on) but no model eval is configured',
            ranAt: now().toISOString(),
            metrics: {},
            misses: [],
          };
      return {
        kind: 'combined',
        passed: retrieval.passed && model.passed,
        summary: `${retrieval.summary}. ${model.summary}`,
        ranAt: now().toISOString(),
        metrics: retrieval.metrics,
        misses: retrieval.misses,
        parts: [retrieval, model],
      };
    },
  };
}
