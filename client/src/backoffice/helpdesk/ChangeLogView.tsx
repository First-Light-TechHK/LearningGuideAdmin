import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { FAQ_CHANGE_SUBJECTS, type FaqChange, type FaqChangePerson } from '../contracts/helpdesk'
import { listFaqChanges } from '../lib/helpdeskApi'
import {
  CHANGE_PAGE_SIZE,
  CHANGE_RANGES,
  CHANGE_SEARCH_MAX,
  actionLabel,
  actionTone,
  changeDate,
  changeSummary,
  changeTitle,
  personName,
  personRole,
  readChangeFilters,
  subjectLabel,
  writeChangeFilters,
  type ChangeFilters,
  type ChangeRange,
  type ChangeType,
} from '../lib/helpdeskChanges'
import { pageWindow, showingRange } from '../lib/helpdeskFaqs'
import { errorMessage } from '../lib/helpdeskFormat'
import { resyncQuery } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdSearchIcon } from './icons'

/**
 * Change Log Tab（Figma 草案 2.6，用户 2026-10-30 确认）：顶上说明「记录不能改不能删」，搜索 + 修改人 + 改动类型 +
 * 时间范围，表格（时间 / 修改人 / 改了什么 / 改动 / 查看详情），分页。所有能进 Help Desk 的角色都能看（只读）。
 * 筛选与页码都在地址栏（?tab=changes&q=&by=&type=&range=&faq=&page=），刷新 / 分享不丢；
 * faq= 来自 FAQ 抽屉 History 的「Open in Change Log」，顶上标出只看这一条，可一键去掉。
 * 「查看详情」交给页面打开改动详情抽屉（2.7）。
 */

type Props = {
  locale: Locale
  /** 详情抽屉关掉后父组件递增（FAQ 抽屉里保存过），触发刷新。 */
  refreshKey: number
  /** opener：点的那个「View details」，详情关掉后焦点回到它。 */
  onOpen: (change: FaqChange, opener: HTMLElement) => void
}

type Loaded = {
  changes: FaqChange[]
  total: number
  people: FaqChangePerson[]
}

export function ChangeLogView({ locale, refreshKey, onOpen }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = readChangeFilters(searchParams)
  const filterKey = JSON.stringify(filters)
  const [search, setSearch] = useState(filters.q)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const requestKey = `${filterKey}#${refreshKey}`
  const loading = settledFor !== requestKey
  const request = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 只看一条 FAQ 时它的问题（从记录里找；它的记录被别的筛选滤空时保留上一次找到的）
  const [faqQuestion, setFaqQuestion] = useState<{
    id: string
    text: string
  } | null>(null)

  useEffect(() => {
    const id = ++request.current
    const asked = JSON.parse(filterKey) as ChangeFilters
    void listFaqChanges(asked).then((result) => {
      if (id !== request.current) return
      if (result.ok) {
        // 回来的形状不对（旧服务端、代理页）也不能把页面弄崩
        const rows = Array.isArray(result.data?.changes) ? result.data.changes : []
        setLoaded({
          changes: rows,
          total: Number.isFinite(result.data?.total) ? result.data.total : rows.length,
          people: Array.isArray(result.data?.people) ? result.data.people : [],
        })
        setErrorCode(null)
        if (asked.faq) {
          const node = rows.flatMap((change) => [change.faq, change.child]).find((candidate) => candidate?.id === asked.faq)
          if (node)
            setFaqQuestion({
              id: node.id,
              text: locale === 'zh-CN' ? node.questionZh : node.questionEn,
            })
        }
      } else {
        setErrorCode(result.code)
      }
      setSettledFor(`${filterKey}#${refreshKey}`)
    })
  }, [filterKey, refreshKey, locale])

  useEffect(() => {
    setSearch((current) => resyncQuery(current, filters.q, searchTimer.current !== null, CHANGE_SEARCH_MAX))
  }, [filters.q])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  // 防抖后的搜索要用最新的地址栏参数（与 FaqsView 一样，见那里的注释）
  const latestParams = useRef(searchParams)
  useEffect(() => {
    latestParams.current = searchParams
  }, [searchParams])

  function update(patch: Partial<ChangeFilters>, replace = false) {
    const next = writeChangeFilters(latestParams.current, 'page' in patch ? patch : { ...patch, page: 1 })
    latestParams.current = next
    setSearchParams(next, { replace })
  }

  function onSearch(value: string) {
    setSearch(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      update({ q: value.slice(0, CHANGE_SEARCH_MAX) }, true)
    }, 300)
  }

  const rows = loaded?.changes ?? []
  const total = loaded?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / CHANGE_PAGE_SIZE))
  const range = showingRange(filters.page, CHANGE_PAGE_SIZE, total)
  const filtered = filters.q !== '' || filters.by !== 'all' || filters.type !== 'all' || filters.range !== 'all' || filters.faq !== ''
  const people = loaded?.people ?? []
  // 地址栏里的人不在名单里（旧链接）也要能显示出来
  const byKnown = filters.by === 'all' || filters.by === 'system' || people.some((p) => p.id === filters.by)

  return (
    <div className="hdFaqs hdChanges">
      <p className="hdChangesNote">
        <span className="hdChangesNoteDot" aria-hidden="true" />
        {t(locale, 'helpDesk.changes.note')}
      </p>

      {filters.faq ? (
        <div className="hdChangesFaqFilter">
          <span>
            {faqQuestion?.id === filters.faq
              ? t(locale, 'helpDesk.changes.faqFilter', {
                  question: faqQuestion.text,
                })
              : t(locale, 'helpDesk.changes.faqFilterUnknown')}
          </span>
          <button type="button" className="hdLinkButton" onClick={() => update({ faq: '' })}>
            {t(locale, 'helpDesk.changes.clearFaq')}
          </button>
        </div>
      ) : null}

      <div className="hdFaqFilters">
        <label className="hdFaqSearch hdChangesSearch">
          <HdSearchIcon size={10} className="hdFaqSearchIcon" />
          <input
            type="search"
            value={search}
            maxLength={CHANGE_SEARCH_MAX}
            placeholder={t(locale, 'helpDesk.changes.search')}
            aria-label={t(locale, 'helpDesk.changes.search')}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <select
          className="hdFaqSelect hdChangesSelect"
          aria-label={t(locale, 'helpDesk.changes.byLabel')}
          value={filters.by}
          onChange={(event) => update({ by: event.target.value })}
        >
          <option value="all">{t(locale, 'helpDesk.changes.everyone')}</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name || t(locale, 'helpDesk.changes.formerEmployee')}
            </option>
          ))}
          {!byKnown ? <option value={filters.by}>{t(locale, 'helpDesk.changes.formerEmployee')}</option> : null}
          <option value="system">{t(locale, 'helpDesk.changes.system')}</option>
        </select>
        <select
          className="hdFaqSelect hdChangesSelect"
          aria-label={t(locale, 'helpDesk.changes.typeLabel')}
          value={filters.type}
          onChange={(event) => update({ type: event.target.value as ChangeType })}
        >
          {(['all', ...FAQ_CHANGE_SUBJECTS] as const).map((type) => (
            <option key={type} value={type}>
              {t(locale, `helpDesk.changes.types.${type}`)}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdChangesSelect"
          aria-label={t(locale, 'helpDesk.changes.rangeLabel')}
          value={filters.range}
          onChange={(event) => update({ range: event.target.value as ChangeRange })}
        >
          {CHANGE_RANGES.map((value) => (
            <option key={value} value={value}>
              {t(locale, `helpDesk.changes.ranges.${value}`)}
            </option>
          ))}
        </select>
        {loaded ? (
          <span className="hdFaqCount" aria-live="polite">
            {total === 1 ? t(locale, 'helpDesk.changes.countOne') : t(locale, 'helpDesk.changes.count', { count: total })}
          </span>
        ) : null}
      </div>

      {errorCode ? (
        <div className="hdNotice hdFaqError" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      <div className="hdFaqTableWrap" aria-busy={loading}>
        <table className="hdFaqTable hdChangesTable">
          <colgroup>
            <col className="hdChangesColWhen" />
            <col className="hdChangesColBy" />
            <col className="hdChangesColWhat" />
            <col className="hdChangesColChange" />
            <col className="hdChangesColAction" />
          </colgroup>
          <thead>
            <tr>
              {(['when', 'by', 'what', 'change'] as const).map((column) => (
                <th key={column} scope="col">
                  {t(locale, `helpDesk.changes.columns.${column}`)}
                </th>
              ))}
              <th scope="col">
                <span className="hdVisuallyHidden">{t(locale, 'helpDesk.changes.columns.action')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((change) => {
              const when = changeDate(change.at, locale)
              const title = changeTitle(locale, change)
              const action = actionLabel(locale, change)
              return (
                <tr key={change.id} className="hdChangesRow">
                  <td>
                    <div className="hdChangesStrong hdChangesDate">{when.date}</div>
                    <div className="hdChangesSub">{when.time}</div>
                  </td>
                  <td>
                    <div className="hdChangesStrong">{personName(locale, change)}</div>
                    <div className="hdChangesSub">{personRole(locale, change)}</div>
                  </td>
                  <td>
                    <div className="hdChangesKind">{subjectLabel(locale, change)}</div>
                    <div className="hdChangesStrong hdChangesTitle">{title}</div>
                  </td>
                  <td>
                    <span className={`hdChangeChip hdChangeChip-${actionTone(change)}`}>{action}</span>
                    <div className="hdChangesSub hdChangesSummary">{changeSummary(locale, change)}</div>
                  </td>
                  <td className="hdChangesActionCell">
                    <button
                      type="button"
                      className="hdFaqPreview hdChangesView"
                      aria-label={t(locale, 'helpDesk.changes.viewDetailsLabel', { action, title })}
                      onClick={(event) => onOpen(change, event.currentTarget)}
                    >
                      {t(locale, 'helpDesk.changes.viewDetails')}
                    </button>
                  </td>
                </tr>
              )
            })}
            {loaded && rows.length === 0 && !errorCode ? (
              <tr>
                <td colSpan={5} className="hdFaqEmpty">
                  {t(locale, filtered ? 'helpDesk.changes.emptyFiltered' : 'helpDesk.changes.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {total > 0 ? (
        <footer className="hdFaqFooter">
          <span>
            {t(locale, 'helpDesk.changes.showing', {
              from: range.from,
              to: range.to,
              total,
            })}
          </span>
          <nav className="hdFaqPages" aria-label={t(locale, 'helpDesk.faqs.pagination')}>
            {filters.page > 1 ? (
              <button
                type="button"
                className="hdFaqPageStep"
                aria-label={t(locale, 'helpDesk.faqs.previous')}
                onClick={() => update({ page: filters.page - 1 })}
              >
                ‹
              </button>
            ) : null}
            {pageWindow(Math.min(filters.page, totalPages), totalPages).map((item, index) =>
              item === 'gap' ? (
                <span key={`gap-${index}`} className="hdFaqPageGap" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={`hdFaqPage${item === filters.page ? ' hdFaqPageActive' : ''}`}
                  aria-label={t(locale, 'helpDesk.faqs.page', { page: item })}
                  aria-current={item === filters.page ? 'page' : undefined}
                  onClick={() => (item === filters.page ? undefined : update({ page: item }))}
                >
                  {item}
                </button>
              ),
            )}
            <button
              type="button"
              className="hdFaqPageStep"
              aria-label={t(locale, 'helpDesk.faqs.next')}
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
