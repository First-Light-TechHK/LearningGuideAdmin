import { useEffect, useId, useRef, useState } from 'react'

import {
  formatChartValue,
  formatTick,
  nearestIndex,
  segments,
  smoothPaths,
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
 * 一张大折线图（手写 SVG，客户端不装图表库），样式参考 Google Analytics / Material 3：
 * 平滑但不越过数据的单调曲线 + 下面一层淡淡的渐变面积；虚线网格、三根刻度、至多 7 个日期；
 * 最近一个点画实心圆；悬停 / 键盘左右键出竖线和白底提示卡（日期、数值、分子 / 分母）。
 * null 的桶断开不画（不画成 0）；不完整的周画空心点。一条线、一根 y 轴、单一蓝色，不需要图例。
 * 进场时线从左往右画出来（尊重「减少动态效果」）。待视觉验收。
 */

type Props = {
  label: string
  kind: ChartKind
  points: readonly ChartPoint[]
  bucketLabel: (bucket: string) => string
  shortLabel: (bucket: string) => string
  emptyLabel: string
  partialLabel: string
  height?: number
}

const PAD = { left: 44, right: 16, top: 16, bottom: 28 }

export function LineChart({ label, kind, points, bucketLabel, shortLabel, emptyLabel, partialLabel, height = 236 }: Props) {
  const uid = useId().replace(/:/g, '')
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
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

  const frame: Frame = { width, height, ...PAD }
  const domain = yDomain(kind, points)
  const ticks = yTicks(domain)
  const { line, area } = smoothPaths(points, domain, frame)
  const hasData = points.some((point) => point.value !== null)
  const lonely = segments(points, domain, frame).filter((seg) => seg.length === 1)
  const lastIndex = points.map((point) => point.value !== null).lastIndexOf(true)
  const point = active !== null ? points[active] : null
  const tipX = active !== null ? xAt(active, points.length, frame) : 0
  const tipLeft = Math.min(Math.max(tipX, 84), width - 84)
  const base = height - PAD.bottom
  // 换一组数据就重放进场动画
  const drawKey = `${kind}-${points.length}-${points[0]?.bucket ?? ''}-${line.length}`

  function move(clientX: number) {
    const rect = box.current?.getBoundingClientRect()
    if (!rect || points.length === 0) return
    setActive(nearestIndex(clientX - rect.left, points.length, frame))
  }

  return (
    <div
      ref={box}
      className="hdChartPlot"
      tabIndex={hasData ? 0 : -1}
      role="img"
      aria-label={`${label}: ${points.map((p) => `${bucketLabel(p.bucket)} ${formatChartValue(kind, p.value)}`).join('; ')}`}
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
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <linearGradient id={`${uid}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="hdChartFillTop" />
            <stop offset="100%" className="hdChartFillBottom" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => {
          const y = yAt(tick, domain, frame)
          return (
            <g key={tick} className={`hdChartRule${index === 0 ? ' hdChartRuleBase' : ''}`}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
              <text x={PAD.left - 10} y={y} dy="0.32em" textAnchor="end">
                {formatTick(kind, tick)}
              </text>
            </g>
          )
        })}
        {xLabelIndexes(points.length, Math.max(2, Math.min(7, Math.floor(width / 110)))).map((index, at, all) => (
          <text
            key={index}
            className="hdChartAxis"
            x={xAt(index, points.length, frame)}
            y={height - 8}
            textAnchor={all.length > 1 && at === 0 ? 'start' : all.length > 1 && at === all.length - 1 ? 'end' : 'middle'}
          >
            {shortLabel(points[index].bucket)}
          </text>
        ))}
        <g key={drawKey} className="hdChartDraw">
          {area ? <path className="hdChartArea" d={area} fill={`url(#${uid}-fill)`} /> : null}
          {line ? <path className="hdChartLine" d={line} pathLength={1} /> : null}
        </g>
        {lonely.map(([xy]) => (
          <circle key={`${xy.x}`} className="hdChartDot" cx={xy.x} cy={xy.y} r={3.5} />
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
        {lastIndex >= 0 && active === null && !points[lastIndex].partial ? (
          <circle
            className="hdChartDotLast"
            cx={xAt(lastIndex, points.length, frame)}
            cy={yAt(points[lastIndex].value as number, domain, frame)}
            r={4.5}
          />
        ) : null}
        {point ? (
          <g className="hdChartFocus">
            <line x1={tipX} x2={tipX} y1={PAD.top} y2={base} />
            {point.value !== null ? <circle cx={tipX} cy={yAt(point.value, domain, frame)} r={5.5} /> : null}
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
          <span className="hdChartTipRow">
            <span className="hdChartTipKey" aria-hidden="true" />
            <span className="hdChartTipLabel">{label}</span>
            <strong>{formatChartValue(kind, point.value)}</strong>
          </span>
          {point.detail ? <span className="hdChartTipDetail">{point.detail}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
