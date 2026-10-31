import type { FlywheelJobRun, MetricsRow } from '../contracts/helpdesk'
import { miningRunSummary, type RateKey } from './helpdeskFlywheel'

/**
 * 「HelpDesk 数据」折线图的纯逻辑（参考 Chatwoot 报表：每个指标一张折线图，共用上面的时间范围）。
 * 一张图一条线、一根 y 轴；比率固定从 0 起，评分固定 1 到 5，计数从 0 到一个整齐的上限。
 * 没有数据的时间桶（分母为 0）是 null：线在那里断开，不画成 0。
 */

export type ChartPoint = {
  /** 时间桶：YYYY-MM-DD（按周时是那一周的周一）。 */
  bucket: string
  value: number | null
  /** 不完整的周：点画成空心，提示里写出来。 */
  partial?: boolean
  /** 提示里的小字，如「31 / 50」。 */
  detail?: string
}

export type ChartKind = 'rate' | 'rating' | 'count'

export type ChartSpec = {
  id: string
  kind: ChartKind
  points: ChartPoint[]
}

/** 图上展示的指标与顺序：运行（提问量、没匹配）→ AI 效果 → 客服（转人工）→ 用户反馈。 */
export const CHART_METRICS = ['turns', 'aiSolvedRate', 'noMatchRate', 'handoverRate', 'helpfulRate', 'avgRating'] as const
export type ChartMetric = (typeof CHART_METRICS)[number]

export function chartKind(metric: ChartMetric | 'jobReceived'): ChartKind {
  if (metric === 'turns' || metric === 'jobReceived') return 'count'
  return metric === 'avgRating' ? 'rating' : 'rate'
}

/** 把趋势行变成一条线的点（按时间排好；重复的桶只留第一个）。 */
export function metricPoints(
  rows: readonly MetricsRow[],
  metric: ChartMetric,
  detail?: (row: MetricsRow, key: RateKey) => string,
): ChartPoint[] {
  const seen = new Set<string>()
  const points: ChartPoint[] = []
  for (const row of rows) {
    if (!row.bucket || seen.has(row.bucket)) continue
    seen.add(row.bucket)
    const value = metric === 'turns' ? row.turns : row[metric]
    points.push({
      bucket: row.bucket.slice(0, 10),
      value: typeof value === 'number' && Number.isFinite(value) ? value : null,
      partial: row.partial || undefined,
      detail: metric !== 'turns' && detail ? detail(row, metric) : undefined,
    })
  }
  return points.sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/** 后台任务（缺口挖掘）：每天最后一次运行拉进来的对话轮数；失败的运行记成 null（线断开）。 */
export function jobPoints(runs: readonly FlywheelJobRun[]): ChartPoint[] {
  const byDay = new Map<string, FlywheelJobRun>()
  for (const run of runs) {
    const current = byDay.get(run.day)
    if (!current || run.startedAt > current.startedAt) byDay.set(run.day, run)
  }
  return [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((run) => ({
      bucket: run.day.slice(0, 10),
      value: run.status === 'succeeded' ? miningRunSummary(run.stats).received : null,
    }))
}

export type RunMark = { day: string; status: FlywheelJobRun['status']; errorCode: string | null; created: number }

/** 运行状态条：每天一格（最后一次运行的状态）。 */
export function runMarks(runs: readonly FlywheelJobRun[]): RunMark[] {
  const byDay = new Map<string, FlywheelJobRun>()
  for (const run of runs) {
    const current = byDay.get(run.day)
    if (!current || run.startedAt > current.startedAt) byDay.set(run.day, run)
  }
  return [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((run) => ({
      day: run.day.slice(0, 10),
      status: run.status,
      errorCode: run.errorCode,
      created: miningRunSummary(run.stats).created,
    }))
}

/** 计数轴的整齐上限：1、2、2.5、5 乘 10 的幂，至少 1。 */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power
  return 10 * power
}

/** y 轴的范围：比率 0 到（不超过 100% 的）整齐上限，评分 1 到 5，计数 0 到整齐上限。 */
export function yDomain(kind: ChartKind, points: readonly ChartPoint[]): [number, number] {
  if (kind === 'rating') return [1, 5]
  const max = Math.max(0, ...points.map((point) => point.value ?? 0))
  if (kind === 'rate') return [0, Math.min(1, niceMax(max <= 0 ? 0.1 : max))]
  return [0, niceMax(max)]
}

/** 三根刻度：底、中、顶。 */
export function yTicks([low, high]: [number, number]): number[] {
  return [low, low + (high - low) / 2, high]
}

export type Frame = { width: number; height: number; left: number; right: number; top: number; bottom: number }

/** 点在画布上的位置；只有一个点时放在中间。 */
export function xAt(index: number, count: number, frame: Frame): number {
  const span = frame.width - frame.left - frame.right
  if (count <= 1) return frame.left + span / 2
  return frame.left + (index / (count - 1)) * span
}

export function yAt(value: number, [low, high]: [number, number], frame: Frame): number {
  const span = frame.height - frame.top - frame.bottom
  const share = high === low ? 0 : (Math.min(Math.max(value, low), high) - low) / (high - low)
  return frame.top + (1 - share) * span
}

/** SVG 路径：遇到 null 断开（新的一段从 M 开始）；孤立的单点不画线（交给圆点）。 */
export function linePath(points: readonly ChartPoint[], domain: [number, number], frame: Frame): string {
  const parts: string[] = []
  let open = false
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false
      return
    }
    const x = xAt(index, points.length, frame).toFixed(1)
    const y = yAt(point.value, domain, frame).toFixed(1)
    parts.push(`${open ? 'L' : 'M'}${x} ${y}`)
    open = true
  })
  return parts.join(' ')
}

/** 离指针最近的点（按 x）。 */
export function nearestIndex(x: number, count: number, frame: Frame): number {
  if (count <= 1) return 0
  const span = frame.width - frame.left - frame.right
  const index = Math.round(((x - frame.left) / span) * (count - 1))
  return Math.min(count - 1, Math.max(0, index))
}

/** 最近一个有值的点（图头的大数字）。 */
export function latestValue(points: readonly ChartPoint[]): ChartPoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index].value !== null) return points[index]
  return null
}

/** x 轴标签：头、中、尾三个（点少时去重）。 */
export function xLabelIndexes(count: number): number[] {
  if (count <= 0) return []
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])]
}

export function formatChartValue(kind: ChartKind, value: number | null): string {
  if (value === null) return '—'
  if (kind === 'rate') return `${(value * 100).toFixed(value >= 0.1 || value === 0 ? 0 : 1)}%`
  if (kind === 'rating') return value.toFixed(2)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** 轴刻度的字：比率不带小数。 */
export function formatTick(kind: ChartKind, value: number): string {
  if (kind === 'rate') return `${Math.round(value * 100)}%`
  if (kind === 'rating') return String(Math.round(value * 10) / 10)
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value * 10) / 10)
}
