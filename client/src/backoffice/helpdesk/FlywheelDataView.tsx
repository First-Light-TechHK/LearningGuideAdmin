import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  METRICS_GRANULARITIES,
  METRICS_SPLITS,
  type FlywheelJobRun,
  type FlywheelMetrics,
  type MetricsGranularity,
  type MetricsRow,
  type MetricsSplit,
} from '../contracts/helpdesk'
import { getFlywheelMetrics, listJobRuns } from '../lib/helpdeskApi'
import {
  CHART_METRICS,
  GOOD_DIRECTION,
  chartKind,
  formatChange,
  jobPoints,
  lastChange,
  metricPoints,
  runMarks,
} from '../lib/helpdeskCharts'
import {
  METRICS_RANGES,
  RATE_KEYS,
  RATE_PARTS,
  formatMetric,
  formatRate,
  metricsWindow,
  overallTotals,
  type RateKey,
} from '../lib/helpdeskFlywheel'
import { contentLocaleLabel, errorMessage, faqSignalLabel } from '../lib/helpdeskFormat'
import { cardTime, longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { LineChart } from './LineChart'

/**
 * 「HelpDesk 数据」Tab（v5 Part G6，没有 Figma 画板，沿用 FAQs Tab 的筛选行与表格样式，待视觉验收）：
 * - 7 张卡片（整段时间、不切分）：AI 解决率、没有匹配率、有帮助率、平均评分、转人工率、澄清覆盖率、
 *   守卫回退率；分母为 0 显示 —，卡片下写分子 / 分母；
 * - 趋势表（按日 / 按周的每个时间桶），AI 解决率带一条横条（只是装饰，数字是正文）；
 * - 切分（语言 / 入口 / 信号）时多一张按切分值的合计表，卡片仍是整体；
 * - 最大的缺口组（「打开」到 FAQ 候选）与最常导致工单的 FAQ；
 * - 数据来自 Portal 的 insights 每晚拉进 Admin 的事实表，SQL 视图算出（没有第二个数据源），
 *   页头写最近一次拉取的时间。
 * - owner 2026-10-31：要折线图。参考 Chatwoot 报表：每个指标一张折线图（提问量、AI 解决率、没匹配率、
 *   转人工率、有帮助率、平均评分）+ 后台任务（每晚缺口挖掘拉进来的轮数与每天的运行状态），共用上面的时间范围；
 *   手写 SVG（LineChart.tsx），趋势表留在图下面当表格视图。客服工单没有按天的数据，暂不画。
 */

type Props = { locale: Locale; onOpenCandidate: (candidateId: string) => void }
type State = { overall: FlywheelMetrics | null; split: FlywheelMetrics | null; error: string | null }
type Runs = { runs: FlywheelJobRun[]; error: string | null } | null
const LIST_PREVIEW = 5
const TREND_TABS = [...CHART_METRICS, 'jobReceived'] as const
type TrendKey = (typeof TREND_TABS)[number]

const today = () => new Date().toISOString().slice(0, 10)
const when = (iso: string, locale: Locale) => `${longDate(iso, locale)} ${cardTime(iso, locale)}`

export function FlywheelDataView({ locale, onOpenCandidate }: Props) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [granularity, setGranularity] = useState<MetricsGranularity>('day')
  const [range, setRange] = useState<number>(METRICS_RANGES.day[1])
  const [split, setSplit] = useState<MetricsSplit>('none')
  const [state, setState] = useState<State>({ overall: null, split: null, error: null })
  // 最近一次回来的请求属于哪组选择：和当前不同就是「加载中」（不在 effect 里同步设 loading）
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const requestKey = `${granularity}#${range}#${split}`
  const loading = settledFor !== requestKey
  const request = useRef(0)
  const [jobs, setJobs] = useState<Runs>(null)
  const [view, setView] = useState<TrendKey>('aiSolvedRate')
  const [list, setList] = useState<'gaps' | 'tickets'>('gaps')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let live = true
    void listJobRuns('gap_mining').then((result) => {
      if (live) setJobs(result.ok ? { runs: result.data.runs, error: null } : { runs: [], error: result.code })
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const id = ++request.current
    const span = metricsWindow(granularity, range, today())
    const asks = [getFlywheelMetrics({ granularity, ...span, split: 'none' })]
    if (split !== 'none') asks.push(getFlywheelMetrics({ granularity, ...span, split }))
    void Promise.all(asks).then(([overall, bySplit]) => {
      if (id !== request.current) return
      const failed = [overall, bySplit].find((result) => result && !result.ok)
      setState({
        overall: overall.ok ? overall.data : null,
        split: bySplit?.ok ? bySplit.data : null,
        error: failed && !failed.ok ? failed.code : null,
      })
      setSettledFor(`${granularity}#${range}#${split}`)
    })
  }, [granularity, range, split])

  function changeGranularity(next: MetricsGranularity) {
    setGranularity(next)
    setRange(METRICS_RANGES[next][next === 'day' ? 1 : 0])
  }

  function segmentLabel(segment: string): string {
    if (state.split?.split === 'locale') return contentLocaleLabel(locale, segment)
    if (state.split?.split === 'entry') {
      const key = `helpDesk.data.entry.${segment}`
      const label = t(locale, key)
      return label === key ? segment : label
    }
    if (segment === 'none') return t(locale, 'helpDesk.data.noSignal')
    return faqSignalLabel(locale, segment)
  }

  function bucketLabel(bucket: string | null): string {
    if (!bucket) return '—'
    const date = longDate(bucket, locale)
    return granularity === 'week' ? t(locale, 'helpDesk.data.weekOf', { date }) : date
  }

  /** 趋势表的一行：不完整的周（这段时间只盖住一部分）标出来，比率不好和完整的周直接比。 */
  function seriesLabel(row: MetricsRow): string {
    const label = bucketLabel(row.bucket)
    return row.partial ? t(locale, 'helpDesk.data.partialWeek', { label }) : label
  }

  const overall = state.overall
  const totals = overall ? overallTotals(overall) : null
  const metricLabel = (key: RateKey) => t(locale, `helpDesk.data.metrics.${key}`)

  function parts(row: MetricsRow, key: RateKey): string {
    const [part, whole] = RATE_PARTS[key]
    if (key === 'avgRating') return t(locale, 'helpDesk.data.ratingParts', { count: row.ratings })
    return t(locale, 'helpDesk.data.parts', { part: row[part] as number, whole: row[whole] as number })
  }

  function rateCells(row: MetricsRow, bar = false) {
    return RATE_KEYS.map((key) => (
      <td key={key} className="hdDataNumber">
        {formatMetric(key, row[key])}
        {bar && key === 'aiSolvedRate' && row[key] !== null ? (
          <span className="hdDataBar" aria-hidden="true">
            <span className="hdDataBarFill" style={{ width: `${Math.round((row[key] ?? 0) * 100)}%` }} />
          </span>
        ) : null}
      </td>
    ))
  }

  function metricsTable(
    id: string,
    title: string,
    firstColumn: string,
    rows: MetricsRow[],
    label: (row: MetricsRow) => string,
    bar: boolean,
  ) {
    return (
      <section className="hdGraphSection hdDataSection" aria-labelledby={id}>
        <h3 className="hdGraphTitle" id={id}>
          {title}
        </h3>
        <div className="hdFaqTableWrap hdDataTableWrap">
          <table className="hdFaqTable hdReleaseTable hdDataTable" aria-labelledby={id}>
            <thead>
              <tr>
                <th scope="col">{firstColumn}</th>
                <th scope="col">{t(locale, 'helpDesk.data.columns.turns')}</th>
                {RATE_KEYS.map((key) => (
                  <th key={key} scope="col">
                    {metricLabel(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.bucket ?? ''}-${row.segment}`}>
                  <th scope="row">{label(row)}</th>
                  <td className="hdDataNumber">{row.turns}</td>
                  {rateCells(row, bar)}
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={RATE_KEYS.length + 2} className="hdFaqEmpty">
                    {t(locale, 'helpDesk.data.emptyTable')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  /** 一个模块：上面一排指标标签（整段时间的数），点哪个下面的大图就画哪个（参考 Google Analytics 的记分卡标签）。 */
  function tabLabel(key: TrendKey): string {
    if (key === 'turns') return t(locale, 'helpDesk.data.charts.turns')
    if (key === 'jobReceived') return t(locale, 'helpDesk.data.charts.jobReceived')
    return metricLabel(key)
  }

  function seriesFor(key: TrendKey) {
    if (key === 'jobReceived') return jobPoints(jobs?.runs ?? [])
    return metricPoints(overall?.series ?? [], key, parts)
  }

  function tabValue(key: TrendKey, row: MetricsRow): string {
    if (key === 'turns') return String(row.turns)
    if (key === 'jobReceived') {
      const marks = runMarks(jobs?.runs ?? [])
      return marks.length === 0 ? '—' : `${marks.filter((mark) => mark.status === 'succeeded').length}/${marks.length}`
    }
    return formatMetric(key, row[key])
  }

  function tabDetail(key: TrendKey, row: MetricsRow): string {
    if (key === 'turns') return t(locale, 'helpDesk.data.charts.turnsDetail', { answers: row.answers })
    if (key === 'jobReceived') return t(locale, 'helpDesk.data.charts.jobDetail')
    return parts(row, key)
  }

  function changeText(key: TrendKey, delta: number): string {
    const kind = chartKind(key)
    const n = formatChange(kind, delta)
    return kind === 'rate' ? t(locale, 'helpDesk.data.charts.changePoints', { n }) : t(locale, 'helpDesk.data.charts.change', { n })
  }

  function listLength(): number {
    return list === 'gaps' ? (overall?.topGaps.length ?? 0) : (overall?.ticketFaqs.length ?? 0)
  }

  function visible<T>(rows: readonly T[]): readonly T[] {
    return showAll ? rows : rows.slice(0, LIST_PREVIEW)
  }

  function onTabKey(event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const at = TREND_TABS.indexOf(view)
    const next = TREND_TABS[(at + (event.key === 'ArrowRight' ? 1 : TREND_TABS.length - 1)) % TREND_TABS.length]
    setView(next)
    document.getElementById(`${uid}-tab-${next}`)?.focus()
  }

  /** x 轴上的短日期：「10/31」。 */
  function shortBucket(bucket: string): string {
    const [, month, day] = bucket.split('-')
    return month && day ? `${Number(month)}/${Number(day)}` : bucket
  }

  /** 后台任务每天一格：成功 ✓、失败 ✕、进行中 …（状态色只配图标和字，不单靠颜色）。 */
  function runStrip() {
    const marks = runMarks(jobs?.runs ?? [])
    if (marks.length === 0) return null
    const failed = marks.filter((mark) => mark.status === 'failed').length
    return (
      <div className="hdRunStrip">
        <span className="hdRunStripLabel">
          {failed > 0
            ? t(locale, 'helpDesk.data.charts.runsFailed', { count: marks.length, failed })
            : t(locale, 'helpDesk.data.charts.runsOk', { count: marks.length })}
        </span>
        <ol className="hdRunMarks" aria-label={t(locale, 'helpDesk.data.charts.runsLabel')}>
          {marks.map((mark) => {
            const status = t(locale, `helpDesk.data.charts.status.${mark.status}`)
            const label = `${longDate(mark.day, locale)} · ${status}${mark.errorCode ? ` · ${mark.errorCode}` : ''}${
              mark.status === 'succeeded' ? ` · ${t(locale, 'helpDesk.data.charts.created', { count: mark.created })}` : ''
            }`
            return (
              <li key={mark.day} className={`hdRunMark hdRunMark-${mark.status}`} title={label} aria-label={label}>
                {mark.status === 'succeeded' ? '✓' : mark.status === 'failed' ? '✕' : '…'}
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

  return (
    <div className="hdFaqs hdFlywheel" aria-busy={loading}>
      <h2 className="hdSrOnly">{t(locale, 'helpDesk.data.title')}</h2>
      <div className="hdFaqFilters hdDataFilters">
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.data.granularity')}
          value={granularity}
          onChange={(event) => changeGranularity(event.target.value as MetricsGranularity)}
        >
          {METRICS_GRANULARITIES.map((value) => (
            <option key={value} value={value}>
              {t(locale, `helpDesk.data.${value}`)}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.data.range')}
          value={range}
          onChange={(event) => setRange(Number(event.target.value))}
        >
          {METRICS_RANGES[granularity].map((value) => (
            <option key={value} value={value}>
              {t(locale, granularity === 'day' ? 'helpDesk.data.rangeDays' : 'helpDesk.data.rangeWeeks', { n: value })}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.data.split')}
          value={split}
          onChange={(event) => setSplit(event.target.value as MetricsSplit)}
        >
          {METRICS_SPLITS.map((value) => (
            <option key={value} value={value}>
              {t(locale, `helpDesk.data.splits.${value}`)}
            </option>
          ))}
        </select>
        {overall ? (
          <span className="hdFaqCount hdDataIngested">
            {overall.lastIngestedAt
              ? t(locale, 'helpDesk.data.lastIngested', { when: when(overall.lastIngestedAt, locale) })
              : t(locale, 'helpDesk.data.neverIngested')}
          </span>
        ) : null}
      </div>
      <p className="hdGraphHint hdDataNote">{t(locale, 'helpDesk.data.utcNote')}</p>
      {split === 'entry' ? <p className="hdGraphHint hdDataNote">{t(locale, 'helpDesk.data.channelHint')}</p> : null}

      {state.error ? (
        <div className="hdNotice hdFaqError" role="alert">
          {errorMessage(locale, state.error)}
        </div>
      ) : null}

      {loading ? <p className="hdMuted hdDataLoading">{t(locale, 'helpDesk.data.loading')}</p> : null}

      {!loading && overall && !totals ? <p className="hdEmptyState hdMuted hdDataEmpty">{t(locale, 'helpDesk.data.empty')}</p> : null}

      {!loading && overall && totals ? (
        <>
          <section className="hdTrend" aria-labelledby={`${uid}-charts`}>
            <h3 className="hdSrOnly" id={`${uid}-charts`}>
              {t(locale, 'helpDesk.data.charts.title')}
            </h3>
            <div className="hdTrendTabs" role="tablist" aria-label={t(locale, 'helpDesk.data.charts.title')} onKeyDown={onTabKey}>
              {TREND_TABS.map((key) => {
                const on = view === key
                // 后台任务的大数字是成功天数，不配「比前一天」
                const change = key === 'jobReceived' ? null : lastChange(seriesFor(key), GOOD_DIRECTION[key])
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`${uid}-tab-${key}`}
                    aria-selected={on}
                    aria-controls={`${uid}-panel`}
                    aria-labelledby={`${uid}-name-${key}`}
                    aria-describedby={`${uid}-value-${key}`}
                    tabIndex={on ? 0 : -1}
                    className={`hdTrendTab${on ? ' hdTrendTabOn' : ''}`}
                    onClick={() => setView(key)}
                  >
                    <span className="hdTrendName" id={`${uid}-name-${key}`}>
                      {tabLabel(key)}
                    </span>
                    <strong className="hdTrendValue" id={`${uid}-value-${key}`}>
                      {tabValue(key, totals)}
                    </strong>
                    <span className="hdTrendDetail">{tabDetail(key, totals)}</span>
                    {change ? (
                      <span className={`hdTrendChange hdTrendChange-${change.tone}`}>
                        <span aria-hidden="true">{change.delta > 0 ? '▲' : change.delta < 0 ? '▼' : '•'}</span>
                        {changeText(key, change.delta)}
                      </span>
                    ) : (
                      <span className="hdTrendChange hdTrendChange-flat">{'\u00a0'}</span>
                    )}
                  </button>
                )
              })}
            </div>
            <div className="hdTrendPanel" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${view}`}>
              <p className="hdTrendCaption">
                {t(locale, `helpDesk.data.charts.caption.${view}`)}
                {view === 'jobReceived'
                  ? null
                  : ` · ${t(locale, granularity === 'day' ? 'helpDesk.data.charts.perDay' : 'helpDesk.data.charts.perWeek')}`}
                {` · ${t(locale, granularity === 'week' && view !== 'jobReceived' ? 'helpDesk.data.charts.vsWeek' : 'helpDesk.data.charts.vsDay')}`}
              </p>
              <LineChart
                label={tabLabel(view)}
                kind={chartKind(view)}
                points={seriesFor(view)}
                bucketLabel={view === 'jobReceived' ? (bucket) => longDate(bucket, locale) : bucketLabel}
                shortLabel={shortBucket}
                emptyLabel={
                  view === 'jobReceived' && jobs?.error
                    ? errorMessage(locale, jobs.error)
                    : t(
                        locale,
                        view === 'jobReceived' && !jobs
                          ? 'helpDesk.data.loading'
                          : view === 'jobReceived'
                            ? 'helpDesk.data.charts.noRuns'
                            : 'helpDesk.data.charts.empty',
                      )
                }
                partialLabel={t(locale, 'helpDesk.data.charts.partial')}
              />
              {view === 'jobReceived' ? runStrip() : null}
            </div>
            <dl className="hdTrendMore">
              {(['clarifyCoveredRate', 'guardFallbackRate'] as const).map((key) => (
                <div key={key} role="group" aria-labelledby={`${uid}-${key}`} title={t(locale, `helpDesk.data.hints.${key}`)}>
                  <dt id={`${uid}-${key}`}>{metricLabel(key)}</dt>
                  <dd>
                    <strong>{formatMetric(key, totals[key])}</strong> <span>{parts(totals, key)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* 趋势表是图的表格视图：默认收起，页面不拉长 */}
          <details className="hdDataDetails">
            <summary className="hdDataSummary">{t(locale, 'helpDesk.data.charts.showTable')}</summary>
            {metricsTable(
              `${uid}-trend`,
              t(locale, 'helpDesk.data.trend'),
              t(locale, 'helpDesk.data.columns.period'),
              overall.series,
              seriesLabel,
              true,
            )}
          </details>

          {split !== 'none' && state.split
            ? metricsTable(
                `${uid}-split`,
                t(locale, `helpDesk.data.bySplitName.${split}`),
                t(locale, 'helpDesk.data.columns.segment'),
                state.split.totals,
                (row) => segmentLabel(row.segment),
                false,
              )
            : null}

          {/* 缺口组与导致工单的 FAQ：同一个模块里切换，各先看前 {LIST_PREVIEW} 条（页面不拉长） */}
          <section className="hdTrend hdDataLists" aria-labelledby={`${uid}-lists`}>
            <h3 className="hdSrOnly" id={`${uid}-lists`}>
              {t(locale, 'helpDesk.data.lists')}
            </h3>
            <div className="hdDataListsHead">
              <div className="hdReviewSeg hdDataSeg" role="tablist" aria-label={t(locale, 'helpDesk.data.lists')}>
                {(['gaps', 'tickets'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={list === key}
                    className={`hdReviewSegItem${list === key ? ' hdReviewSegOn' : ''}`}
                    onClick={() => (setList(key), setShowAll(false))}
                  >
                    {t(locale, key === 'gaps' ? 'helpDesk.data.topGaps' : 'helpDesk.data.ticketFaqs')}
                    <span className="hdDataSegCount">{(key === 'gaps' ? overall.topGaps : overall.ticketFaqs).length}</span>
                  </button>
                ))}
              </div>
              {listLength() > LIST_PREVIEW ? (
                <button type="button" className="hdDataSummary" aria-expanded={showAll} onClick={() => setShowAll((now) => !now)}>
                  {showAll ? t(locale, 'helpDesk.data.showLess') : t(locale, 'helpDesk.data.showAll', { count: listLength() })}
                </button>
              ) : null}
            </div>
            <div className="hdFaqTableWrap hdDataTableWrap hdDataListBody">
              {list === 'gaps' ? (
                <table className="hdFaqTable hdReleaseTable hdDataTable" aria-label={t(locale, 'helpDesk.data.topGaps')}>
                  <thead>
                    <tr>
                      {(['topic', 'suggestion', 'status', 'turns', 'action'] as const).map((column) => (
                        <th key={column} scope="col">
                          {t(locale, `helpDesk.data.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible(overall.topGaps).map((gap) => (
                      <tr key={gap.candidateId}>
                        <th scope="row">
                          <span className="hdReleaseResult">{gap.topic}</span>
                          <span className="hdReleaseResult hdGraphHint">{gap.proposedQuestion}</span>
                        </th>
                        <td>{labelOrRaw(locale, `helpDesk.candidates.suggestion.${gap.suggestion}`, gap.suggestion)}</td>
                        <td>{labelOrRaw(locale, `helpDesk.candidates.status.${gap.status}`, gap.status)}</td>
                        <td className="hdDataNumber">{gap.turns}</td>
                        <td>
                          <button
                            type="button"
                            className="hdFaqPreview"
                            aria-label={t(locale, 'helpDesk.data.openLabel', { topic: gap.topic })}
                            onClick={() => onOpenCandidate(gap.candidateId)}
                          >
                            {t(locale, 'helpDesk.data.open')}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {overall.topGaps.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="hdFaqEmpty">
                          {t(locale, 'helpDesk.data.emptyTable')}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : (
                <table className="hdFaqTable hdReleaseTable hdDataTable" aria-label={t(locale, 'helpDesk.data.ticketFaqs')}>
                  <thead>
                    <tr>
                      {(['faq', 'answers', 'ticketsAfter', 'ticketRate'] as const).map((column) => (
                        <th key={column} scope="col">
                          {t(locale, `helpDesk.data.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible(overall.ticketFaqs).map((row) => (
                      <tr key={row.faqId}>
                        <th scope="row">{(zh ? row.questionZh : row.questionEn) ?? row.key ?? t(locale, 'helpDesk.data.unknownFaq')}</th>
                        <td className="hdDataNumber">{row.answers}</td>
                        <td className="hdDataNumber">{row.ticketsAfter}</td>
                        <td className="hdDataNumber">{formatRate(row.ticketRate)}</td>
                      </tr>
                    ))}
                    {overall.ticketFaqs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="hdFaqEmpty">
                          {t(locale, 'helpDesk.data.emptyTable')}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

function labelOrRaw(locale: Locale, key: string, raw: string): string {
  const value = t(locale, key)
  return value === key ? raw : value
}
