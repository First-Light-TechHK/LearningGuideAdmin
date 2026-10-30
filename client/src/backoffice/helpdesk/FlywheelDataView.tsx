import { useEffect, useId, useRef, useState } from 'react'

import {
  METRICS_GRANULARITIES,
  METRICS_SPLITS,
  type FlywheelMetrics,
  type MetricsGranularity,
  type MetricsRow,
  type MetricsSplit,
} from '../contracts/helpdesk'
import { getFlywheelMetrics } from '../lib/helpdeskApi'
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

/**
 * 「HelpDesk 数据」Tab（v5 Part G6，没有 Figma 画板，沿用 FAQs Tab 的筛选行与表格样式，待视觉验收）：
 * - 7 张卡片（整段时间、不切分）：AI 解决率、没有匹配率、有帮助率、平均评分、转人工率、澄清覆盖率、
 *   守卫回退率；分母为 0 显示 —，卡片下写分子 / 分母；
 * - 趋势表（按日 / 按周的每个时间桶），AI 解决率带一条横条（只是装饰，数字是正文）；
 * - 切分（语言 / 入口 / 信号）时多一张按切分值的合计表，卡片仍是整体；
 * - 最大的缺口组（「打开」到 FAQ 候选）与最常导致工单的 FAQ；
 * - 数据来自 Portal 的 insights 每晚拉进 Admin 的事实表，SQL 视图算出（没有第二个数据源），
 *   页头写最近一次拉取的时间。客户端没有图表库：表格 + 卡片（与现有样式一致）。
 */

type Props = { locale: Locale; onOpenCandidate: (candidateId: string) => void }
type State = { overall: FlywheelMetrics | null; split: FlywheelMetrics | null; error: string | null }

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

  function metricsTable(id: string, title: string, firstColumn: string, rows: MetricsRow[], label: (row: MetricsRow) => string, bar: boolean) {
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
          <div className="hdStatGrid">
            {RATE_KEYS.map((key) => (
              <div key={key} className="hdStatCard" role="group" aria-labelledby={`${uid}-${key}`}>
                <span className="hdStatLabel" id={`${uid}-${key}`}>
                  {metricLabel(key)}
                </span>
                <strong className="hdStatValue">{formatMetric(key, totals[key])}</strong>
                <span className="hdStatDetail">{parts(totals, key)}</span>
                <span className="hdStatHint">{t(locale, `helpDesk.data.hints.${key}`)}</span>
              </div>
            ))}
          </div>

          {metricsTable(
            `${uid}-trend`,
            t(locale, 'helpDesk.data.trend'),
            t(locale, 'helpDesk.data.columns.period'),
            overall.series,
            seriesLabel,
            true,
          )}

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

          <section className="hdGraphSection hdDataSection" aria-labelledby={`${uid}-gaps`}>
            <h3 className="hdGraphTitle" id={`${uid}-gaps`}>
              {t(locale, 'helpDesk.data.topGaps')}
            </h3>
            <div className="hdFaqTableWrap hdDataTableWrap">
              <table className="hdFaqTable hdReleaseTable hdDataTable" aria-labelledby={`${uid}-gaps`}>
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
                  {overall.topGaps.map((gap) => (
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
            </div>
          </section>

          <section className="hdGraphSection hdDataSection" aria-labelledby={`${uid}-tickets`}>
            <h3 className="hdGraphTitle" id={`${uid}-tickets`}>
              {t(locale, 'helpDesk.data.ticketFaqs')}
            </h3>
            <div className="hdFaqTableWrap hdDataTableWrap">
              <table className="hdFaqTable hdReleaseTable hdDataTable" aria-labelledby={`${uid}-tickets`}>
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
                  {overall.ticketFaqs.map((row) => (
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
