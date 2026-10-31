import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import {
  formatChartValue,
  formatTick,
  latestValue,
  linePath,
  nearestIndex,
  xAt,
  xLabelIndexes,
  yAt,
  yDomain,
  yTicks,
  type ChartKind,
  type ChartPoint,
  type Frame,
} from '../lib/helpdeskCharts'

/**
 * 一张折线图（手写 SVG，客户端不装图表库）：一条线、一根 y 轴、三根刻度、头中尾三个日期。
 * 悬停 / 键盘左右键：竖线 + 圆点 + 提示（日期、数值、分子 / 分母）。null 的桶断开不画。
 * 图下面那张趋势表就是表格视图；颜色只用 HelpDesk 蓝（单条线不需要图例）。待视觉验收。
 */

type Props = {
  title: string
  hint?: string
  kind: ChartKind
  points: readonly ChartPoint[]
  bucketLabel: (bucket: string) => string
  shortLabel: (bucket: string) => string
  emptyLabel: string
  partialLabel: string
  latestLabel: (bucket: string) => string
  footer?: ReactNode
}

const HEIGHT = 168
const PAD = { left: 40, right: 12, top: 12, bottom: 24 }

export function LineChart({ title, hint, kind, points, bucketLabel, shortLabel, emptyLabel, partialLabel, latestLabel, footer }: Props) {
  const uid = useId()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(360)
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const frame: Frame = { width, height: HEIGHT, ...PAD }
  const domain = yDomain(kind, points)
  const ticks = yTicks(domain)
  const path = linePath(points, domain, frame)
  const latest = latestValue(points)
  const hasData = latest !== null
  const point = active !== null ? points[active] : null

  function move(clientX: number) {
    const rect = box.current?.getBoundingClientRect()
    if (!rect || points.length === 0) return
    setActive(nearestIndex(clientX - rect.left, points.length, frame))
  }

  // 孤立的点（前后都是 null）没有线段，用实心点画出来
  const lonely = points
    .map((p, index) => ({ p, index }))
    .filter(({ p, index }) => p.value !== null && points[index - 1]?.value == null && points[index + 1]?.value == null)

  const tipX = active !== null ? xAt(active, points.length, frame) : 0
  const tipLeft = Math.min(Math.max(tipX, 70), width - 70)

  return (
    <figure className="hdChart" aria-labelledby={`${uid}-title`}>
      <figcaption className="hdChartHead">
        <span className="hdChartTitle" id={`${uid}-title`}>
          {title}
        </span>
        <strong className="hdChartValue">{latest ? formatChartValue(kind, latest.value) : '—'}</strong>
        {latest ? <span className="hdChartLatest">{latestLabel(latest.bucket)}</span> : null}
        {hint ? <span className="hdChartHint">{hint}</span> : null}
      </figcaption>
      <div
        ref={box}
        className="hdChartPlot"
        tabIndex={hasData ? 0 : -1}
        role="img"
        aria-label={`${title}: ${points.map((p) => `${bucketLabel(p.bucket)} ${formatChartValue(kind, p.value)}`).join('; ')}`}
        onPointerMove={(event) => move(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (points.length === 0) return
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault()
            const step = event.key === 'ArrowRight' ? 1 : -1
            setActive((now) => Math.min(points.length - 1, Math.max(0, (now ?? (step > 0 ? -1 : points.length)) + step)))
          } else if (event.key === 'Escape') setActive(null)
        }}
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true">
          {ticks.map((tick) => {
            const y = yAt(tick, domain, frame)
            return (
              <g key={tick} className="hdChartRule">
                <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
                <text x={PAD.left - 8} y={y} dy="0.32em" textAnchor="end">
                  {formatTick(kind, tick)}
                </text>
              </g>
            )
          })}
          {xLabelIndexes(points.length).map((index, at, all) => (
            <text
              key={index}
              className="hdChartAxis"
              x={xAt(index, points.length, frame)}
              y={HEIGHT - 6}
              textAnchor={all.length > 1 && at === 0 ? 'start' : all.length > 1 && at === all.length - 1 ? 'end' : 'middle'}
            >
              {shortLabel(points[index].bucket)}
            </text>
          ))}
          {path ? <path className="hdChartLine" d={path} /> : null}
          {lonely.map(({ p, index }) => (
            <circle
              key={p.bucket}
              className="hdChartDot"
              cx={xAt(index, points.length, frame)}
              cy={yAt(p.value as number, domain, frame)}
              r={3}
            />
          ))}
          {points.map((p, index) =>
            p.partial && p.value !== null ? (
              <circle
                key={`partial-${p.bucket}`}
                className="hdChartDotPartial"
                cx={xAt(index, points.length, frame)}
                cy={yAt(p.value, domain, frame)}
                r={4}
              />
            ) : null,
          )}
          {point ? (
            <g className="hdChartFocus">
              <line x1={tipX} x2={tipX} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
              {point.value !== null ? <circle cx={tipX} cy={yAt(point.value, domain, frame)} r={5} /> : null}
            </g>
          ) : null}
        </svg>
        {!hasData ? <p className="hdChartEmpty">{emptyLabel}</p> : null}
        {point ? (
          <div className="hdChartTip" role="status" style={{ left: tipLeft }}>
            <span className="hdChartTipDate">
              {bucketLabel(point.bucket)}
              {point.partial ? ` · ${partialLabel}` : ''}
            </span>
            <strong>{formatChartValue(kind, point.value)}</strong>
            {point.detail ? <span className="hdChartTipDetail">{point.detail}</span> : null}
          </div>
        ) : null}
      </div>
      {footer}
    </figure>
  )
}
