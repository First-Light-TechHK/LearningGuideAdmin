import type { FaqGraphRepository } from '../faqs/faqGraphRepository';
import { HelpdeskError } from '../portalHelpdeskClient';
import type {
  InsightRepository,
  MetricsCounts,
  MetricsGranularity,
  MetricsRow,
  MetricsSplit,
} from './insightRepository';

/**
 * 数据飞轮的指标（v5 Part G6）：全部来自 Admin 的事实表 helpdesk_insight_turns 上的视图
 * helpdesk_insight_turn_facts（每晚从 Portal 的 insights 接口拉来；Admin 读不到 Portal 的库）。
 * 比率在这里算，分母为 0 → null（界面显示 —）：
 * - AI 解决率 = 满 24 小时的答案里，24 小时内没有工单的；
 * - 没有匹配率 = no_match / 全部轮；有帮助率 = helpful + solved / 投了票的；平均评分 = 评分和 / 评分数；
 * - 转人工率 = handover / 全部轮；澄清覆盖率 = 覆盖到的澄清 / 澄清；守卫回退率 = 没过守卫 / 有守卫结果的。
 * 按日或周，切分：none | locale | entry（入口 = 轮的 source：submit / chat / chip）| signal。
 */
export const METRICS_LIMITS = {
  dayRangeMax: 92,
  weekRangeMax: 366,
  defaultDays: 28,
  topGaps: 10,
  ticketFaqs: 10,
} as const;

const SPLITS: readonly MetricsSplit[] = ['none', 'locale', 'entry', 'signal'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type MetricsRates = {
  aiSolvedRate: number | null;
  noMatchRate: number | null;
  helpfulRate: number | null;
  avgRating: number | null;
  handoverRate: number | null;
  clarifyCoveredRate: number | null;
  guardFallbackRate: number | null;
};

const ratio = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

export function rates(c: MetricsCounts): MetricsRates {
  return {
    aiSolvedRate: ratio(c.aiSolved, c.answersSettled),
    noMatchRate: ratio(c.noMatch, c.turns),
    helpfulRate: ratio(c.helpful, c.votes),
    avgRating:
      c.ratings === 0
        ? null
        : Math.round((c.ratingSum / c.ratings) * 100) / 100,
    handoverRate: ratio(c.handovers, c.turns),
    clarifyCoveredRate: ratio(c.clarifyCovered, c.clarify),
    guardFallbackRate: ratio(c.guardFallback, c.guarded),
  };
}

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function date(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (
    typeof raw !== 'string' ||
    !DATE.test(raw) ||
    Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ||
    new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw
  )
    throw invalid(`${name} must be a date (YYYY-MM-DD)`);
  return raw;
}

export function createFlywheelMetrics(deps: {
  insights: Pick<
    InsightRepository,
    'metrics' | 'topGapGroups' | 'ticketFaqs' | 'lastIngestedAt'
  >;
  graph: Pick<FaqGraphRepository, 'summaries'>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const day = 86_400_000;
  const withRates = (row: MetricsRow) => ({ ...row, ...rates(row) });

  return {
    async metrics(raw: Record<string, unknown>) {
      const granularity: MetricsGranularity =
        raw.granularity === undefined || raw.granularity === ''
          ? 'day'
          : raw.granularity === 'day' || raw.granularity === 'week'
            ? raw.granularity
            : (() => {
                throw invalid('granularity must be day or week');
              })();
      const split = (
        raw.split === undefined || raw.split === '' ? 'none' : raw.split
      ) as MetricsSplit;
      if (!SPLITS.includes(split))
        throw invalid(`split must be one of ${SPLITS.join(', ')}`);
      const today = now().toISOString().slice(0, 10);
      const to = date(raw.to, 'to') ?? today;
      const from =
        date(raw.from, 'from') ??
        new Date(
          Date.parse(`${to}T00:00:00Z`) -
            (METRICS_LIMITS.defaultDays - 1) * day,
        )
          .toISOString()
          .slice(0, 10);
      if (from > to) throw invalid('from must be on or before to');
      const span =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
          day +
        1;
      const max =
        granularity === 'day'
          ? METRICS_LIMITS.dayRangeMax
          : METRICS_LIMITS.weekRangeMax;
      if (span > max)
        throw invalid(`A ${granularity} view covers at most ${max} days`);
      const range = { from, to };
      const [{ rows, totals }, gaps, tickets, lastIngestedAt] =
        await Promise.all([
          deps.insights.metrics({ granularity, from, to, split }),
          deps.insights.topGapGroups(range, METRICS_LIMITS.topGaps),
          deps.insights.ticketFaqs(range, METRICS_LIMITS.ticketFaqs),
          deps.insights.lastIngestedAt(),
        ]);
      const nodes = new Map(
        (await deps.graph.summaries(tickets.map((t) => t.faqId))).map((n) => [
          n.id,
          n,
        ]),
      );
      return {
        granularity,
        split,
        from,
        to,
        lastIngestedAt,
        source: 'portal_insights' as const,
        series: rows.map(withRates),
        totals: totals.map(withRates),
        topGaps: gaps,
        ticketFaqs: tickets.map((t) => {
          const node = nodes.get(t.faqId);
          return {
            ...t,
            ticketRate: ratio(t.ticketsAfter, t.answers),
            key: node?.key ?? null,
            questionEn: node?.questionEn ?? null,
            questionZh: node?.questionZh ?? null,
          };
        }),
      };
    },
  };
}

export type FlywheelMetrics = ReturnType<typeof createFlywheelMetrics>;
