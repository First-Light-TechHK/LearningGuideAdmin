import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import '../helpdesk.css'
import { SearchIcon } from '../components/icons'
import {
  HELPDESK_TABS,
  isHelpdeskTab,
  type BoardResult,
  type BoardTicket,
  type HelpdeskTab,
} from '../contracts/helpdesk'
import { listTickets } from '../lib/helpdeskApi'
import { categoryLabel, errorMessage, relativeTime, statusLabel } from '../lib/helpdeskFormat'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { useWorkspaceAccess } from '../lib/workspaceAccess'

/**
 * HelpDesk 看板（设计文档 §4A.3）：Tab（带数量）+ 搜索 + 工单卡片网格。
 * 数据来自 BackOffice Server /api/helpdesk/tickets（转发 Portal 集成接口）。
 */

const EMPTY_COUNTS: Record<HelpdeskTab, number> = {
  needsReply: 0,
  waitingUser: 0,
  awaitingConfirm: 0,
  closed: 0,
  all: 0,
}

export function TicketStatusPill({ locale, status }: { locale: Locale; status: string }) {
  return (
    <span className="statusPill hdStatus">
      <span className={`dot hdDot${status}`} aria-hidden="true" />
      {statusLabel(locale, status)}
    </span>
  )
}

export function NotConnectedCard({ locale }: { locale: Locale }) {
  return (
    <section className="card cardGrow">
      <h1 className="cardTitle">{t(locale, 'helpDesk.notConnectedTitle')}</h1>
      <p className="cardBody">{t(locale, 'helpDesk.notConnectedBody')}</p>
    </section>
  )
}

function TicketCard({ ticket, locale }: { ticket: BoardTicket; locale: Locale }) {
  const updated = relativeTime(ticket.lastMessageAt ?? ticket.updatedAt, locale)
  return (
    <Link
      to={`/${locale}/help-desk/${encodeURIComponent(ticket.id)}`}
      className={`hdCard${ticket.needsReply ? ' hdCardNeedsReply' : ''}`}
    >
      <div className="hdCardTop">
        <span className="hdNumber">{ticket.number}</span>
        <TicketStatusPill locale={locale} status={ticket.status} />
      </div>
      <h2 className="hdCardSubject">{ticket.subject}</h2>
      <div className="hdCardMeta">
        <span className="hdChip">{categoryLabel(locale, ticket.category)}</span>
        {ticket.needsReply ? <span className="hdBadge">{t(locale, 'helpDesk.needsReply')}</span> : null}
      </div>
      <div className="hdLearner" title={ticket.learner.email}>
        {ticket.learner.name || ticket.learner.email}
        {ticket.learner.name && ticket.learner.email ? (
          <span className="hdLearnerEmail"> · {ticket.learner.email}</span>
        ) : null}
      </div>
      <div className="hdCardFoot">
        <span>{ticket.assignee?.name || t(locale, 'helpDesk.unassigned')}</span>
        {updated ? <span>{t(locale, 'helpDesk.updated', { time: updated })}</span> : null}
      </div>
    </Link>
  )
}

export default function HelpDeskPage() {
  const locale = useLocale()
  const access = useWorkspaceAccess()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const tab: HelpdeskTab = isHelpdeskTab(rawTab) ? rawTab : 'needsReply'
  const appliedQuery = searchParams.get('q') ?? ''

  const [query, setQuery] = useState(appliedQuery)
  const [data, setData] = useState<BoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 只认最后一次请求的结果，避免切 Tab / 搜索时旧响应覆盖新结果
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setErrorCode(null)
    const result = await listTickets({ tab, q: appliedQuery })
    if (id !== requestId.current) return
    if (result.ok) setData(result.data)
    else setErrorCode(result.code)
    setLoading(false)
  }, [tab, appliedQuery])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  function updateParams(next: { tab?: HelpdeskTab; q?: string }) {
    const params = new URLSearchParams(searchParams)
    if (next.tab !== undefined) params.set('tab', next.tab)
    if (next.q !== undefined) {
      if (next.q.trim() === '') params.delete('q')
      else params.set('q', next.q.trim())
    }
    setSearchParams(params, { replace: true })
  }

  // 与员工列表一致：输入停 300ms 后自动查询
  function onQueryChange(value: string) {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => updateParams({ q: value }), 300)
  }

  async function loadMore() {
    if (!data?.nextCursor) return
    const id = requestId.current
    setLoadingMore(true)
    const result = await listTickets({ tab, q: appliedQuery, cursor: data.nextCursor })
    setLoadingMore(false)
    if (id !== requestId.current) return
    if (result.ok) {
      setData({
        tickets: [...data.tickets, ...result.data.tickets],
        nextCursor: result.data.nextCursor,
        counts: result.data.counts,
      })
    } else {
      setErrorCode(result.code)
    }
  }

  if (errorCode === 'HELPDESK_NOT_CONNECTED') return <NotConnectedCard locale={locale} />

  const counts = data?.counts ?? EMPTY_COUNTS
  const tickets = data?.tickets ?? []

  return (
    <section className="card cardGrow">
      <div className="pageHead">
        <div>
          <h1 className="cardTitle">{t(locale, 'helpDesk.title')}</h1>
          <p className="cardSubtitle">{t(locale, 'helpDesk.subtitle')}</p>
        </div>
        <button type="button" className="button buttonGhost buttonCompact" onClick={() => void load()} disabled={loading}>
          {t(locale, 'helpDesk.refresh')}
        </button>
      </div>

      {access.readOnly ? <div className="alert alertInfo">{t(locale, 'helpDesk.readOnly')}</div> : null}

      <div className="hdTabs" role="tablist" aria-label={t(locale, 'helpDesk.title')}>
        {HELPDESK_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === tab}
            className={`hdTab${key === tab ? ' hdTabActive' : ''}`}
            onClick={() => updateParams({ tab: key })}
          >
            {t(locale, `helpDesk.tabs.${key}`)}
            <span className="hdTabCount">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="filters">
        <label className="searchField">
          <SearchIcon />
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder={t(locale, 'helpDesk.searchPlaceholder')}
            aria-label={t(locale, 'helpDesk.searchPlaceholder')}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      </div>

      {errorCode ? (
        <div className="alert alertError" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      <div className="hdBoard" aria-busy={loading}>
        {loading && !data ? (
          <p className="hdEmpty">{t(locale, 'common.loading')}</p>
        ) : tickets.length === 0 && !errorCode ? (
          <p className="hdEmpty">
            {appliedQuery ? t(locale, 'helpDesk.emptySearch') : t(locale, 'helpDesk.empty')}
          </p>
        ) : (
          <div className="hdGrid">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} locale={locale} />
            ))}
          </div>
        )}
        {data?.nextCursor ? (
          <div className="hdBoardFooter">
            <button
              type="button"
              className="button buttonGhost buttonCompact"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? t(locale, 'common.loading') : t(locale, 'helpDesk.loadMore')}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
