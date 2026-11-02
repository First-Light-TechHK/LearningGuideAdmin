import type {
  HelpdeskQaCandidate,
  HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';

/**
 * 精排（分级方案 L2，owner 2026-11-02：精排也走 OpenRouter，按价格选，参数量不限）。
 *
 * 默认什么都不做：没有 HELPDESK_RERANK_MODEL 或 OPENROUTER_API_KEY 就不精排，候选顺序和以前一样。
 * 每次现读（不用重新部署）：
 * - HELPDESK_RERANK_MODEL：OpenRouter /rerank 的模型（如 voyageai/rerank-2.5-lite、qwen/qwen3-reranker-8b）。
 * - HELPDESK_RERANK_KEEP：精排后留给模型看的候选数（缺省全留）。
 * - HELPDESK_RERANK_DIRECT：「分数,领先差距」，如 0.83,0.05：没有屏幕上的卡片、第一名是答案卡、
 *   分数与领先第二名的差距都够 → 直接给卡，不调用大模型（阈值只在开发集上标定）。不设 = 从不直接给。
 * 精排失败或超时（RERANK_LIMITS.timeoutMs）→ 原顺序，学员不会因为它拿不到候选；不重试。
 */
export const RERANK_LIMITS = {
  timeoutMs: 1_500,
  /** 每张卡给精排看的答案字数（问题全给）。 */
  answerChars: 600,
  queryChars: 600,
  /** 召回池里向量那一路至多几张（S650 dev：字词 10 张 ∪ 向量 10 张，平均 16.5 张，正确卡在池里 99.5%）。 */
  vectorPool: 10,
} as const;

export type RerankConfig = {
  model: string;
  keep: number | null;
  direct: { score: number; margin: number } | null;
};

export function rerankConfig(env: NodeJS.ProcessEnv): RerankConfig | null {
  const model = env.HELPDESK_RERANK_MODEL?.trim();
  if (!model || !env.OPENROUTER_API_KEY?.trim()) return null;
  const keepRaw = Number(env.HELPDESK_RERANK_KEEP?.trim());
  const keep = Number.isInteger(keepRaw) && keepRaw > 0 ? keepRaw : null;
  const parts = (env.HELPDESK_RERANK_DIRECT ?? '')
    .split(',')
    .map((part) => Number(part.trim()));
  const direct =
    parts.length === 2 &&
    parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
    env.HELPDESK_RERANK_DIRECT?.trim()
      ? { score: parts[0], margin: parts[1] }
      : null;
  return { model, keep, direct };
}

export type Reranker = (
  query: string,
  documents: string[],
) => Promise<number[] | null>;

/** OpenRouter POST /rerank：返回与 documents 同序的分数；失败、超时、条数不对 → null。 */
export function openRouterReranker(input: {
  model: string;
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Reranker {
  const doFetch = input.fetch ?? fetch;
  return async (query, documents) => {
    if (documents.length === 0) return [];
    try {
      const response = await doFetch(
        `${input.baseUrl.replace(/\/+$/, '')}/rerank`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            query: query.slice(0, RERANK_LIMITS.queryChars),
            documents,
          }),
          signal: AbortSignal.timeout(
            input.timeoutMs ?? RERANK_LIMITS.timeoutMs,
          ),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        results?: { index?: unknown; relevance_score?: unknown }[];
      };
      const scores: (number | null)[] = documents.map(() => null);
      for (const row of body.results ?? []) {
        if (
          typeof row.index === 'number' &&
          Number.isInteger(row.index) &&
          row.index >= 0 &&
          row.index < documents.length &&
          typeof row.relevance_score === 'number'
        )
          scores[row.index] = row.relevance_score;
      }
      return scores.every((s) => s !== null) ? scores : null;
    } catch {
      return null;
    }
  };
}

const rerankDocument = (c: HelpdeskQaCandidate) =>
  `${c.question}\n${c.answer.slice(0, RERANK_LIMITS.answerChars)}`;

/**
 * 候选按精排分数从高到低重排（同分保持原顺序），每张带上 rerankScore，至多留 keep 张。
 * 只改 findCandidates；精排失败就原样返回。
 */
export function rerankedSource(
  qa: HelpdeskQaSource,
  reranker: Reranker,
  keep: number | null,
): HelpdeskQaSource {
  return {
    ...qa,
    findCandidates: async (search) => {
      // 召回池 = 原来的候选（字词检索 + 树上近亲）∪ 向量最像的 RERANK_LIMITS.vectorPool 个（来源支持时）
      const [retrieved, vector] = await Promise.all([
        qa.findCandidates(search),
        qa.findVectorCandidates
          ? qa
              .findVectorCandidates({
                locale: search.locale,
                text: search.text,
                limit: RERANK_LIMITS.vectorPool,
              })
              .catch(() => [])
          : Promise.resolve([]),
      ]);
      const seen = new Set(retrieved.map((c) => c.id));
      const found = [
        ...retrieved,
        ...vector.filter((c) => !seen.has(c.id) && seen.add(c.id)),
      ];
      if (found.length === 0) return found;
      const scores = await reranker(search.text, found.map(rerankDocument));
      if (!scores) return retrieved;
      const ranked = found
        .map((c, index) => ({ c, index, score: scores[index] }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ c, score }) => ({ ...c, rerankScore: score }));
      return keep ? ranked.slice(0, keep) : ranked;
    },
  };
}

/**
 * 精排有把握时直接给第一名（不调用大模型）：第一名有 rerankScore、是答案卡（不是 choice），
 * 分数 ≥ direct.score，且比第二名高出 ≥ direct.margin（只有一张时差距按它自己的分数算）。
 */
export function directPick(
  candidates: HelpdeskQaCandidate[],
  direct: RerankConfig['direct'],
): HelpdeskQaCandidate | null {
  if (!direct) return null;
  const [top, second] = candidates;
  if (!top || top.rerankScore === undefined) return null;
  if ((top.type ?? 'answer') !== 'answer') return null;
  const margin = top.rerankScore - (second?.rerankScore ?? 0);
  return top.rerankScore >= direct.score && margin >= direct.margin
    ? top
    : null;
}
