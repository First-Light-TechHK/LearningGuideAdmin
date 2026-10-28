import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import type { AgentActionInput, EnquiryDetail, EnquiryRow } from '../contracts/helpdesk'
import { getEnquiry, listEnquiries, newIdempotencyKey, sendAction, sendMessage, type HelpdeskResult } from '../lib/helpdeskApi'
import { errorMessage } from '../lib/helpdeskFormat'
import {
  applyDetailToRow,
  claimInput,
  enquiryControls,
  markReadInput,
  mergeTickets,
  readEnquiryFilters,
  shouldMarkRead,
  writeEnquiryFilters,
  type EnquiryFilters,
} from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { EnquiryConversation, type Notice } from './EnquiryConversation'
import { EnquiryList } from './EnquiryList'
import { StudentPanel } from './StudentPanel'

/**
 * Enquiries 三栏（Figma 1324:2，设计文档 §4A.3）：左列表 / 中对话 / 右学员信息。
 * 筛选写在地址栏（可收藏、可分享），选中的咨询在路径里（/help-desk/:ticketId）。
 */

type Props = { locale: Locale; ticketId: string | null; canWrite: boolean }

export function NotConnected({ locale }: { locale: Locale }) {
  return (
    <div className="hdEmptyState">
      <h2 className="hdEmptyTitle">{t(locale, 'helpDesk.notConnectedTitle')}</h2>
      <p className="hdMuted">{t(locale, 'helpDesk.notConnectedBody')}</p>
    </div>
  )
}

export function EnquiriesView({ locale, ticketId, canWrite }: Props) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filterKey = searchParams.toString()
  const filters = readEnquiryFilters(searchParams)
  const { q, status, category, tag } = filters

  const [query, setQuery] = useState(q)
  const [rows, setRows] = useState<EnquiryRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [ticket, setTicket] = useState<EnquiryDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const listRequest = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 详情请求回来时，确认员工还停在同一条咨询上（切走了就丢弃旧响应）
  const currentTicket = useRef<string | null>(ticketId)
  useEffect(() => {
    currentTicket.current = ticketId
  }, [ticketId])

  /* ---------------------------------- 列表 ---------------------------------- */

  const loadList = useCallback(async () => {
    const id = ++listRequest.current
    setListLoading(true)
    setListError(null)
    const result = await listEnquiries({ q, status, category, tag })
    if (id !== listRequest.current) return
    if (result.ok) {
      setRows(result.data.tickets)
      setNextCursor(result.data.nextCursor)
    } else {
      setRows([])
      setNextCursor(null)
      setListError(result.code)
    }
    setListLoading(false)
  }, [q, status, category, tag])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || listLoading) return
    const id = listRequest.current
    setLoadingMore(true)
    const result = await listEnquiries({ q, status, category, tag }, nextCursor)
    setLoadingMore(false)
    if (id !== listRequest.current) return
    if (result.ok) {
      setRows((current) => mergeTickets(current, result.data.tickets))
      setNextCursor(result.data.nextCursor)
    } else {
      setListError(result.code)
      setNextCursor(null)
    }
  }, [nextCursor, loadingMore, listLoading, q, status, category, tag])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  function updateFilters(patch: Partial<EnquiryFilters>) {
    setSearchParams(writeEnquiryFilters(searchParams, patch), { replace: true })
  }

  // 与员工列表一致：输入停 300ms 后自动查询
  function onQueryChange(value: string) {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => updateFilters({ q: value }), 300)
  }

  function select(id: string) {
    navigate({ pathname: `/${locale}/help-desk/${encodeURIComponent(id)}`, search: filterKey ? `?${filterKey}` : '' })
  }

  /* ---------------------------------- 详情 ---------------------------------- */

  const adopt = useCallback((detail: EnquiryDetail) => {
    setTicket(detail)
    setRows((current) => applyDetailToRow(current, detail))
  }, [])

  const loadTicket = useCallback(
    async (id: string) => {
      const result = await getEnquiry(id)
      if (currentTicket.current !== id) return null
      if (result.ok) {
        adopt(result.data)
        setDetailError(null)
        return result.data
      }
      setDetailError(result.code)
      return null
    },
    [adopt],
  )

  useEffect(() => {
    setTicket(null)
    setNotice(null)
    setDetailError(null)
    if (!ticketId) return
    let cancelled = false
    void (async () => {
      const detail = await loadTicket(ticketId)
      // 打开即已读（只对 FULL；VIEW 打开不清未读）。失败不打扰员工，下次打开再试。
      if (cancelled || !detail || !shouldMarkRead(detail, canWrite)) return
      const result = await sendAction(detail.id, markReadInput(detail), newIdempotencyKey())
      if (cancelled || currentTicket.current !== detail.id) return
      // 未读以 Portal 为准：失败时不在本地清除
      if (result.ok) adopt(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [ticketId, canWrite, loadTicket, adopt])

  /** 写操作结果：成功换成最新工单；409 stale 重新加载并提示；其它错误内联显示一次。 */
  async function settle(result: HelpdeskResult<EnquiryDetail>, id: string): Promise<boolean> {
    if (result.ok) {
      adopt(result.data)
      setNotice(null)
      return true
    }
    if (result.code === 'STALE_TICKET') {
      await loadTicket(id)
      setNotice({ kind: 'info', text: t(locale, 'helpDesk.stale') })
      return false
    }
    setNotice({ kind: 'error', text: errorMessage(locale, result.code) })
    return false
  }

  async function runAction(input: AgentActionInput, label: string): Promise<boolean> {
    if (!ticket || busy) return false
    setBusy(label)
    const ok = await settle(await sendAction(ticket.id, input, newIdempotencyKey()), ticket.id)
    setBusy(null)
    return ok
  }

  async function claim() {
    if (!ticket) return
    if (await runAction(claimInput(ticket), 'claim')) {
      setNotice({ kind: 'info', text: t(locale, 'helpDesk.claimedNotice') })
    }
  }

  async function markReviewed() {
    if (!ticket) return
    if (await runAction({ action: 'propose_resolution', expectedSequence: ticket.sequence }, 'review')) {
      setNotice({ kind: 'info', text: t(locale, 'helpDesk.reviewedNotice') })
    }
  }

  async function send(body: string, internal: boolean, key: string): Promise<boolean> {
    if (!ticket || busy) return false
    setBusy('send')
    const ok = await settle(
      await sendMessage(ticket.id, { body, internal, expectedSequence: ticket.sequence }, key),
      ticket.id,
    )
    setBusy(null)
    return ok
  }

  /* ---------------------------------- 渲染 ---------------------------------- */

  if (listError === 'HELPDESK_NOT_CONNECTED' || detailError === 'HELPDESK_NOT_CONNECTED') {
    return <NotConnected locale={locale} />
  }

  const controls = ticket ? enquiryControls(ticket, canWrite) : null

  return (
    <div className="hdMain">
      <EnquiryList
        locale={locale}
        rows={rows}
        selectedId={ticketId}
        filters={filters}
        query={query}
        loading={listLoading}
        loadingMore={loadingMore}
        hasMore={nextCursor !== null}
        errorCode={listError}
        onQueryChange={onQueryChange}
        onFiltersChange={updateFilters}
        onSelect={select}
        onLoadMore={() => void loadMore()}
      />
      {ticket && controls ? (
        <>
          <EnquiryConversation
            key={ticket.id}
            locale={locale}
            ticket={ticket}
            controls={controls}
            notice={notice}
            busy={busy}
            onClaim={() => void claim()}
            onMarkReviewed={() => void markReviewed()}
            onSend={send}
          />
          <StudentPanel
            key={`side-${ticket.id}`}
            locale={locale}
            ticket={ticket}
            editTags={controls.editTags}
            busy={busy}
            onAddTag={(value) => runAction({ action: 'add_tag', tag: value, expectedSequence: ticket.sequence }, 'tag')}
            onRemoveTag={(value) =>
              void runAction({ action: 'remove_tag', tag: value, expectedSequence: ticket.sequence }, 'tag')
            }
          />
        </>
      ) : (
        <div className="hdConversation hdConversationEmpty">
          {ticketId && detailError ? (
            <div className="hdEmptyState">
              <p className="hdMuted">
                {detailError === 'TICKET_NOT_FOUND' || detailError === 'INVALID_INPUT'
                  ? t(locale, 'helpDesk.notFound')
                  : errorMessage(locale, detailError)}
              </p>
              <button type="button" className="hdLinkButton" onClick={() => void loadTicket(ticketId)}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          ) : ticketId ? (
            <p className="hdMuted hdCentered">{t(locale, 'common.loading')}</p>
          ) : (
            <p className="hdMuted hdCentered">{t(locale, 'helpDesk.selectPrompt')}</p>
          )}
        </div>
      )}
    </div>
  )
}
