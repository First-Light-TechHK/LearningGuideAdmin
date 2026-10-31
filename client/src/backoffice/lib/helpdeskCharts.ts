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

/** x 轴标签：均匀取至多 `max` 个（含头尾，点少时去重）。 */
export function xLabelIndexes(count: number, max = 5): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  const slots = Math.min(max, count)
  return [...new Set(Array.from({ length: slots }, (_, i) => Math.round((i * (count - 1)) / (slots - 1))))]
}

type XY = { x: number; y: number }

/** 单调三次曲线（Fritsch–Carlson）：平滑但不越过数据（不会画出比真实更高或更低的峰）。 */
function monotonePath(points: readonly XY[]): string {
  if (points.length === 0) return ''
  const f = (n: number) => n.toFixed(1)
  if (points.length === 1) return `M${f(points[0].x)} ${f(points[0].y)}`
  const n = points.length
  const d: number[] = []
  for (let k = 0; k < n - 1; k += 1) d.push((points[k + 1].y - points[k].y) / (points[k + 1].x - points[k].x || 1))
  const m: number[] = points.map((_, k) => {
    if (k === 0) return d[0]
    if (k === n - 1) return d[n - 2]
    return d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2
  })
  for (let k = 0; k < n - 1; k += 1) {
    if (d[k] === 0) {
      m[k] = 0
      m[k + 1] = 0
      continue
    }
    const a = m[k] / d[k]
    const b = m[k + 1] / d[k]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[k] = t * a * d[k]
      m[k + 1] = t * b * d[k]
    }
  }
  let path = `M${f(points[0].x)} ${f(points[0].y)}`
  for (let k = 0; k < n - 1; k += 1) {
    const h = points[k + 1].x - points[k].x
    path += ` C${f(points[k].x + h / 3)} ${f(points[k].y + (m[k] * h) / 3)} ${f(points[k + 1].x - h / 3)} ${f(points[k + 1].y - (m[k + 1] * h) / 3)} ${f(points[k + 1].x)} ${f(points[k + 1].y)}`
  }
  return path
}

/** 连续有值的几段（遇到 null 断开），每段是画布坐标。 */
export function segments(points: readonly ChartPoint[], domain: [number, number], frame: Frame): XY[][] {
  const out: XY[][] = []
  let current: XY[] = []
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 0) out.push(current)
      current = []
      return
    }
    current.push({ x: xAt(index, points.length, frame), y: yAt(point.value, domain, frame) })
  })
  if (current.length > 0) out.push(current)
  return out
}

/** 平滑的线与它下面的面积（每段各自闭合到底线）；只有一个点的段不画线（交给圆点）。 */
export function smoothPaths(points: readonly ChartPoint[], domain: [number, number], frame: Frame): { line: string; area: string } {
  const base = (frame.height - frame.bottom).toFixed(1)
  const lines: string[] = []
  const areas: string[] = []
  for (const seg of segments(points, domain, frame)) {
    if (seg.length < 2) continue
    const line = monotonePath(seg)
    lines.push(line)
    areas.push(`${line} L${seg[seg.length - 1].x.toFixed(1)} ${base} L${seg[0].x.toFixed(1)} ${base} Z`)
  }
  return { line: lines.join(' '), area: areas.join(' ') }
}

/** 哪个方向算变好：提问量没有好坏。 */
export type Direction = 'up' | 'down' | 'none'

export const GOOD_DIRECTION: Record<ChartMetric | 'jobReceived', Direction> = {
  turns: 'none',
  aiSolvedRate: 'up',
  noMatchRate: 'down',
  handoverRate: 'down',
  helpfulRate: 'up',
  avgRating: 'up',
  jobReceived: 'none',
}

export type Change = { delta: number; tone: 'good' | 'bad' | 'flat' | 'neutral' }

/** 最近一个点比它前一个有值的点：变化量与好坏（比率按百分点）。 */
export function lastChange(points: readonly ChartPoint[], good: Direction): Change | null {
  const values = points.filter((point) => point.value !== null).map((point) => point.value as number)
  if (values.length < 2) return null
  const delta = values[values.length - 1] - values[values.length - 2]
  if (Math.abs(delta) < 1e-9) return { delta: 0, tone: 'flat' }
  if (good === 'none') return { delta, tone: 'neutral' }
  return { delta, tone: delta > 0 === (good === 'up') ? 'good' : 'bad' }
}

/** 变化量的字：比率「3.2 个百分点」交给文案，这里只给数字部分。 */
export function formatChange(kind: ChartKind, delta: number): string {
  const size = Math.abs(delta)
  if (kind === 'rate') return (size * 100).toFixed(size * 100 >= 10 ? 0 : 1)
  if (kind === 'rating') return size.toFixed(2)
  return Number.isInteger(size) ? String(size) : size.toFixed(1)
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
