import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  CANDIDATE_LIMITS,
  CANDIDATE_ORIGINS,
  CANDIDATE_STATUSES,
  CANDIDATE_SUGGESTIONS,
  type CandidateList,
  type CandidateOrigin,
  type CandidateStatus,
  type CandidateSuggestion,
} from '../contracts/helpdesk'
import { listCandidates } from '../lib/helpdeskApi'
import { showingRange } from '../lib/helpdeskFaqs'
import {
  CANDIDATE_PAGE_SIZE,
  DEFAULT_CANDIDATE_FILTERS,
  readCandidateFilters,
  sourceMixEntries,
  writeCandidateFilters,
  type CandidateFilters,
} from '../lib/helpdeskFlywheel'
import { errorMessage } from '../lib/helpdeskFormat'
import { longDate, resyncQuery } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { FlywheelJobs } from './FlywheelJobs'
import { HdSearchIcon } from './icons'

/**
 * 「FAQ 候选」Tab（v5 Part G4，没有 Figma 画板，沿用 FAQs Tab 的筛选行、表格与分页样式，待视觉验收）：
 * - 顶上是后台任务（夜间缺口挖掘、Portal 的原文保留）与「立即运行」（FULL）；
 * - 队列按条数从多到少（服务端排序），筛选状态（缺省待处理）/ 建议 / 来源与文字，都在地址栏；
 * - 每行：话题与提议的问题、建议、AI 没解决的原因构成、条数、最近出现、「查看」（打开详情抽屉，
 *   ?candidate=<id>，所有角色都能看；动作只给 FULL）。
 */

type Props = {
  locale: Locale
  canWrite: boolean
  /** 详情里的决定、FAQ 编辑器接受了候选后递增，触发刷新。 */
  refreshKey: number
  onOpen: (candidateId: string) => void
  onRefresh: () => void
}

export function CandidatesView({ locale, canWrite, refreshKey, onOpen, onRefresh }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = readCandidateFilters(searchParams)
  const filterKey = JSON.stringify(filters)
  const [search, setSearch] = useState(filters.q)
  const [loaded, setLoaded] = useState<CandidateList | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const requestKey = `${filterKey}#${refreshKey}`
  const loading = settledFor !== requestKey
  const request = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestParams = useRef(searchParams)
  useEffect(() => {
    latestParams.current = searchParams
  }, [searchParams])

  useEffect(() => {
    const id = ++request.current
    void listCandidates(JSON.parse(filterKey) as CandidateFilters).then((result) => {
      if (id !== request.current) return
      if (result.ok) {
        setLoaded(result.data)
        setErrorCode(null)
      } else setErrorCode(result.code)
      setSettledFor(`${filterKey}#${refreshKey}`)
    })
  }, [filterKey, refreshKey])

  useEffect(() => {
    setSearch((current) => resyncQuery(current, filters.q, searchTimer.current !== null, CANDIDATE_LIMITS.qMax))
  }, [filters.q])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  function update(patch: Partial<CandidateFilters>, replace = false) {
    const next = writeCandidateFilters(latestParams.current, 'page' in patch ? patch : { ...patch, page: 1 })
    latestParams.current = next
    setSearchParams(next, { replace })
  }

  function onSearch(value: string) {
    setSearch(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      update({ q: [...value].slice(0, CANDIDATE_LIMITS.qMax).join('') }, true)
    }, 300)
  }

  const rows = loaded?.candidates ?? []
  const total = loaded?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / CANDIDATE_PAGE_SIZE))
  const range = showingRange(filters.page, CANDIDATE_PAGE_SIZE, total)
  const filtered =
    filters.q !== '' || filters.suggestion !== 'all' || filters.origin !== 'all' || filters.status !== DEFAULT_CANDIDATE_FILTERS.status
  const emptyKey = !filtered ? 'empty' : filters.status === 'all' && filters.q === '' && filters.suggestion === 'all' && filters.origin === 'all' ? 'emptyAll' : 'emptyFiltered'

  return (
    <div className="hdFaqs hdCandidates">
      <FlywheelJobs locale={locale} canWrite={canWrite} onMiningFinished={onRefresh} />

      <div className="hdFaqFilters hdCandidateFilters">
        <label className="hdFaqSearch">
          <HdSearchIcon size={10} className="hdFaqSearchIcon" />
          <input
            type="search"
            value={search}
            maxLength={CANDIDATE_LIMITS.qMax}
            placeholder={t(locale, 'helpDesk.candidates.search')}
            aria-label={t(locale, 'helpDesk.candidates.search')}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.candidates.statusLabel')}
          value={filters.status}
          onChange={(event) => update({ status: event.target.value as CandidateStatus | 'all' })}
        >
          <option value="all">{t(locale, 'helpDesk.candidates.allStatuses')}</option>
          {CANDIDATE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(locale, `helpDesk.candidates.status.${status}`)}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.candidates.suggestionLabel')}
          value={filters.suggestion}
          onChange={(event) => update({ suggestion: event.target.value as CandidateSuggestion | 'all' })}
        >
          <option value="all">{t(locale, 'helpDesk.candidates.allSuggestions')}</option>
          {CANDIDATE_SUGGESTIONS.map((suggestion) => (
            <option key={suggestion} value={suggestion}>
              {t(locale, `helpDesk.candidates.suggestion.${suggestion}`)}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.candidates.originLabel')}
          value={filters.origin}
          onChange={(event) => update({ origin: event.target.value as CandidateOrigin | 'all' })}
        >
          <option value="all">{t(locale, 'helpDesk.candidates.allOrigins')}</option>
          {CANDIDATE_ORIGINS.map((origin) => (
            <option key={origin} value={origin}>
              {t(locale, `helpDesk.candidates.origin.${origin}`)}
            </option>
          ))}
        </select>
        {loaded ? (
          <span className="hdFaqCount" aria-live="polite">
            {t(locale, 'helpDesk.candidates.counts', loaded.counts)}
          </span>
        ) : null}
      </div>

      {errorCode ? (
        <div className="hdNotice hdFaqError" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      <div className="hdFaqTableWrap" aria-busy={loading}>
        <table className="hdFaqTable hdCandidateTable">
          <colgroup>
            <col className="hdCandidateColTopic" />
            <col className="hdCandidateColSuggestion" />
            <col className="hdCandidateColMix" />
            <col className="hdCandidateColCount" />
            <col className="hdCandidateColSeen" />
            <col className="hdCandidateColAction" />
          </colgroup>
          <thead>
            <tr>
              {(['topic', 'suggestion', 'mix', 'count', 'lastSeen', 'action'] as const).map((column) => (
                <th key={column} scope="col">
                  {t(locale, `helpDesk.candidates.columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="hdFaqQuestion">
                    {row.topic}
                    {row.status !== 'new' ? (
                      <span className="hdGraphTag hdFaqNodeTag">{t(locale, `helpDesk.candidates.status.${row.status}`)}</span>
                    ) : null}
                  </div>
                  <div className="hdFaqSummary">{row.proposedQuestion}</div>
                </td>
                <td>
                  <span className={`hdFaqChip hdCandidateSuggestion hdCandidateSuggestion-${row.suggestion}`}>
                    {t(locale, `helpDesk.candidates.suggestion.${row.suggestion}`)}
                  </span>
                </td>
                <td>
                  <div className="hdCandidateMix">
                    {sourceMixEntries(row.sourceMix).map(([key, count]) => (
                      <span key={key} className="hdGraphTag">
                        {t(locale, 'helpDesk.candidates.mixItem', { label: t(locale, `helpDesk.candidates.mix.${key}`), count })}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="hdCandidateCount">{row.turnCount}</td>
                <td className="hdFaqDate">{longDate(row.lastSeenAt, locale)}</td>
                <td>
                  <button
                    type="button"
                    className="hdFaqPreview"
                    aria-label={t(locale, 'helpDesk.candidates.reviewLabel', { topic: row.topic })}
                    onClick={() => onOpen(row.id)}
                  >
                    {t(locale, 'helpDesk.candidates.review')}
                  </button>
                </td>
              </tr>
            ))}
            {loaded && rows.length === 0 && !errorCode ? (
              <tr>
                <td colSpan={6} className="hdFaqEmpty">
                  {t(locale, `helpDesk.candidates.${emptyKey}`)}
                </td>
              </tr>
            ) : null}
            {!loaded && loading ? (
              <tr>
                <td colSpan={6} className="hdFaqEmpty">
                  {t(locale, 'helpDesk.candidates.loading')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {total > CANDIDATE_PAGE_SIZE ? (
        <footer className="hdFaqFooter">
          <span>{t(locale, 'helpDesk.candidates.showing', { from: range.from, to: range.to, total })}</span>
          <nav className="hdFaqPages" aria-label={t(locale, 'helpDesk.candidates.pagination')}>
            <button
              type="button"
              className="hdFaqPageStep"
              aria-label={t(locale, 'helpDesk.candidates.previous')}
              disabled={filters.page <= 1}
              onClick={() => update({ page: filters.page - 1 })}
            >
              ‹
            </button>
            <span className="hdFaqPage hdFaqPageActive" aria-current="page">
              {filters.page}
            </span>
            <button
              type="button"
              className="hdFaqPageStep"
              aria-label={t(locale, 'helpDesk.candidates.next')}
              disabled={filters.page >= totalPages}
              onClick={() => update({ page: filters.page + 1 })}
            >
              ›
            </button>
          </nav>
        </footer>
      ) : null}
    </div>
  )
}
