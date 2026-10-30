import {
  CANDIDATE_LIMITS,
  CANDIDATE_ORIGINS,
  CANDIDATE_STATUSES,
  CANDIDATE_SUGGESTIONS,
  FAQ_CATEGORIES,
  SOURCE_MIX_KEYS,
  type CandidateExample,
  type CandidateOrigin,
  type CandidateStatus,
  type CandidateSuggestion,
  type FaqCandidate,
  type FaqCandidateDraft,
  type FaqCategory,
  type FlywheelMetrics,
  type MetricsGranularity,
  type MetricsRates,
  type MetricsRow,
  type MetricsSplit,
  type SourceMix,
  type SourceMixKey,
} from '../contracts/helpdesk'
import type { FaqDraft } from './helpdeskFaqs'

/**
 * v5 Part G4「FAQ 候选」与 G6「HelpDesk 数据」的纯逻辑（界面待视觉验收）。
 * - 队列的筛选在地址栏（?tab=candidates&status=&suggestion=&origin=&q=&page=），缺省看待处理的（new）；
 *   服务端按条数从多到少排。
 * - 例句都是 Portal 脱敏过的（占位符 <email>、<phone> …）；带占位符的不能当问法（服务端同样拒绝）。
 * - 决定（接受、驳回）带 version 与 Idempotency-Key：同一个决定重试沿用同一个 key，换了决定换新。
 * - 指标的时间窗以今天（UTC）为止：按日 7 / 28 / 92 天，按周 12 / 26 / 52 周（服务端上限 92 / 366 天）。
 */

export const CANDIDATE_PAGE_SIZE = 20

export type CandidateFilters = {
  status: CandidateStatus | 'all'
  suggestion: CandidateSuggestion | 'all'
  origin: CandidateOrigin | 'all'
  q: string
  page: number
}

export const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  status: 'new',
  suggestion: 'all',
  origin: 'all',
  q: '',
  page: 1,
}

function pick<T extends string>(value: string | null, values: readonly T[], fallback: T | 'all'): T | 'all' {
  if (value === 'all') return 'all'
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 地址栏 → 筛选；不认识的值回到缺省。 */
export function readCandidateFilters(params: URLSearchParams): CandidateFilters {
  const page = Number(params.get('page'))
  return {
    status: pick(params.get('status'), CANDIDATE_STATUSES, DEFAULT_CANDIDATE_FILTERS.status),
    suggestion: pick(params.get('suggestion'), CANDIDATE_SUGGESTIONS, 'all'),
    origin: pick(params.get('origin'), CANDIDATE_ORIGINS, 'all'),
    q: [...(params.get('q') ?? '')].slice(0, CANDIDATE_LIMITS.qMax).join(''),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  }
}

/** 筛选 → 地址栏：保留 tab、candidate 等别的参数，缺省值不写。 */
export function writeCandidateFilters(params: URLSearchParams, patch: Partial<CandidateFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  const merged = { ...readCandidateFilters(params), ...patch }
  for (const key of ['status', 'suggestion', 'origin', 'q', 'page'] as const) {
    const value = String(merged[key])
    if (value === String(DEFAULT_CANDIDATE_FILTERS[key]) || value === '') next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** GET /api/helpdesk/faq-candidates 的查询串。 */
export function candidateQuery(filters: CandidateFilters): string {
  const query = new URLSearchParams()
  if (filters.status !== 'all') query.set('status', filters.status)
  if (filters.suggestion !== 'all') query.set('suggestion', filters.suggestion)
  if (filters.origin !== 'all') query.set('origin', filters.origin)
  const q = filters.q.trim()
  if (q) query.set('q', q)
  query.set('page', String(filters.page))
  query.set('pageSize', String(CANDIDATE_PAGE_SIZE))
  return query.toString()
}

const PLACEHOLDER = /<([a-z_]+)>/g

export function hasPlaceholder(text: string): boolean {
  return /<[a-z_]+>/.test(text)
}

export type TextSegment = { text: string; placeholder: string | null }

/** 例句拆成文字与占位符（占位符单独标出：「隐藏的个人信息」）。 */
export function textSegments(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let at = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0
    if (start > at) out.push({ text: text.slice(at, start), placeholder: null })
    out.push({ text: match[0], placeholder: match[1] })
    at = start + match[0].length
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), placeholder: null })
  return out
}

/** 能当问法的例句（不含占位符）的序号：接受时的缺省勾选。 */
export function cleanExampleIndexes(examples: readonly CandidateExample[]): number[] {
  return examples.flatMap((example, index) => (hasPlaceholder(example.text) ? [] : [index]))
}

/** 原因构成：多的在前，一样多按服务端的顺序；0 不显示。 */
export function sourceMixEntries(mix: SourceMix): [SourceMixKey, number][] {
  return SOURCE_MIX_KEYS.map((key): [SourceMixKey, number] => [key, mix[key] ?? 0])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || SOURCE_MIX_KEYS.indexOf(a[0]) - SOURCE_MIX_KEYS.indexOf(b[0]))
}

/** 写操作只给 FULL，而且只对待处理的候选。 */
export function canDecide(candidate: Pick<FaqCandidate, 'status'>, canWrite: boolean): boolean {
  return canWrite && candidate.status === 'new'
}

export type DecisionKey = { key: string; body: string }

/** 决定的 Idempotency-Key：同一个决定重试沿用，换了决定换新（服务端同 key 不同决定回 422）。 */
export function decisionKey(previous: DecisionKey | null, body: unknown, make: () => string): DecisionKey {
  const text = JSON.stringify(body)
  if (previous && previous.body === text) return previous
  return { key: make(), body: text }
}

function isFaqCategory(value: string | null): value is FaqCategory {
  return value !== null && (FAQ_CATEGORIES as readonly string[]).includes(value)
}

/** FAQ 编辑器的预填：问题与分类来自候选，答案留空由员工写；追问不是入口。 */
export function faqDraftFromCandidate(draft: FaqCandidateDraft, as: 'new_faq' | 'follow_up'): FaqDraft {
  return {
    category: isFaqCategory(draft.faq.category) ? draft.faq.category : null,
    popular: false,
    questionEn: draft.faq.questionEn,
    answerEn: '',
    questionZh: draft.faq.questionZh,
    answerZh: '',
    keywords: draft.faq.keywords.join(', '),
    type: 'answer',
    entry: as !== 'follow_up',
    signals: [],
  }
}

/** 「转成 FAQ 候选」：只给 FULL，只对已解决的工单（CLOSED，不是学员撤回的）。 */
export function canTurnIntoCandidate(ticket: { status: string; closeReason?: string | null }, canWrite: boolean): boolean {
  return canWrite && ticket.status === 'CLOSED' && ticket.closeReason !== 'cancelled'
}

/* ---------------------------------- 指标 ---------------------------------- */

export const RATE_KEYS = [
  'aiSolvedRate',
  'noMatchRate',
  'helpfulRate',
  'avgRating',
  'handoverRate',
  'clarifyCoveredRate',
  'guardFallbackRate',
] as const satisfies readonly (keyof MetricsRates)[]
export type RateKey = (typeof RATE_KEYS)[number]

/** 每个比率的分子 / 分母（卡片下的小字「12 / 40」）。 */
export const RATE_PARTS: Record<RateKey, [keyof MetricsRow, keyof MetricsRow]> = {
  aiSolvedRate: ['aiSolved', 'answersSettled'],
  noMatchRate: ['noMatch', 'turns'],
  helpfulRate: ['helpful', 'votes'],
  avgRating: ['ratingSum', 'ratings'],
  handoverRate: ['handovers', 'turns'],
  clarifyCoveredRate: ['clarifyCovered', 'clarify'],
  guardFallbackRate: ['guardFallback', 'guarded'],
}

export function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function formatRating(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

export function formatMetric(key: RateKey, value: number | null): string {
  return key === 'avgRating' ? formatRating(value) : formatRate(value)
}

/** 时间窗的选项：按日几天，按周几周。 */
export const METRICS_RANGES: Record<MetricsGranularity, readonly number[]> = { day: [7, 28, 92], week: [12, 26, 52] }

const DAY = 86_400_000

export function metricsWindow(granularity: MetricsGranularity, range: number, today: string): { from: string; to: string } {
  const days = granularity === 'week' ? range * 7 : range
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY).toISOString().slice(0, 10)
  return { from, to: today }
}

export function metricsQuery(input: { granularity: MetricsGranularity; from: string; to: string; split: MetricsSplit }): string {
  return new URLSearchParams({
    granularity: input.granularity,
    from: input.from,
    to: input.to,
    split: input.split,
  }).toString()
}

/** 不切分时的整段合计（卡片用）；这段时间没有任何一轮 → null（空状态）。 */
export function overallTotals(metrics: Pick<FlywheelMetrics, 'split' | 'totals'>): MetricsRow | null {
  if (metrics.split !== 'none') return null
  const row = metrics.totals[0]
  return row && row.turns > 0 ? row : null
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const obj = (value: unknown) =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : ({} as Record<string, unknown>)

/** 一次缺口挖掘的计数：拉了几轮、新建 / 并进了几个候选（运行行的 stats）。 */
export function miningRunSummary(stats: Record<string, unknown>): {
  pull: string | null
  received: number
  created: number
  grown: number
} {
  const pull = obj(stats.pull)
  const mine = obj(stats.mine)
  return {
    pull: typeof pull.status === 'string' ? pull.status : null,
    received: num(pull.received),
    created: num(mine.created),
    grown: num(mine.grown),
  }
}
