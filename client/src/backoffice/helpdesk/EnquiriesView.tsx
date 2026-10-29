import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { TIMELINE_LIMIT, type AgentActionInput, type EnquiryDetail, type EnquiryRow } from '../contracts/helpdesk'
import {
  getEnquiry,
  listEnquiries,
  listTimeline,
  newIdempotencyKey,
  sendAction,
  sendMessage,
  type HelpdeskResult,
} from '../lib/helpdeskApi'
import { errorMessage } from '../lib/helpdeskFormat'
import {
  applyDetailToRow,
  claimInput,
  clearBusy,
  enquiryControls,
  flagInput,
  markReadOnOpen,
  mergeTickets,
  NO_BUSY,
  readEnquiryFilters,
  resyncQuery,
  settlePlan,
  startBusy,
  timelineCards,
  visibleBusy,
  writeEnquiryFilters,
  type Busy,
  type BusyToken,
  type ComposerKey,
  type EnquiryFilters,
} from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { EnquiryList } from './EnquiryList'
import { EnquiryTimeline, type Notice, type Panel, type TimelineEntry } from './EnquiryTimeline'
import { StudentPanel } from './StudentPanel'

/**
 * Enquiries 三栏（Figma 1324:2，设计文档 §4A.3，Tickets v2 §3d）：左列表 / 中间是选中工单的学员时间线 /
 * 右学员信息。筛选写在地址栏（可收藏、可分享），选中的工单在路径里（/help-desk/:ticketId）。
 * 时间线上每张卡片都有自己的操作栏：写操作按卡片的工单 id 与 sequence 发出，结果只提示在那张卡片下。
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
  const { q, status, category, tag, flagged } = filters

  const [query, setQuery] = useState(q)
  const [rows, setRows] = useState<EnquiryRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // 打开过的工单详情（按 id）：时间线上已打开过的卡片也能显示正文、附件与 AI 块
  const [details, setDetails] = useState<Record<string, EnquiryDetail>>({})
  const [timeline, setTimeline] = useState<{ learnerId: string; rows: EnquiryRow[] } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [panel, setPanel] = useState<Panel>(null)
  // 进行中的写操作属于发出它的那条工单（切到别的工单后不再禁用那边的按钮）
  const [busy, setBusy] = useState<Busy>(NO_BUSY)
  // 回复 / 备注草稿（按「工单 id:reply|note」）放在这里：中栏在切换工单、加载详情时会卸载，草稿不能跟着丢
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const composerKeys = useRef<Record<string, ComposerKey | null>>({})
  const ticket = ticketId ? (details[ticketId] ?? null) : null
  const learnerId = ticket?.learner.id ?? ''

  const listRequest = useRef(0)
  const timelineRequest = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 中栏现在显示的卡片：写操作的结果只在卡片还在屏幕上时提示
  const visibleIds = useRef<Set<string>>(new Set())
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
    const result = await listEnquiries({ q, status, category, tag, flagged })
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
  }, [q, status, category, tag, flagged])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || listLoading) return
    const id = listRequest.current
    setLoadingMore(true)
    const result = await listEnquiries({ q, status, category, tag, flagged }, nextCursor)
    setLoadingMore(false)
    if (id !== listRequest.current) return
    if (result.ok) {
      setRows((current) => mergeTickets(current, result.data.tickets))
      setNextCursor(result.data.nextCursor)
    } else {
      setListError(result.code)
      setNextCursor(null)
    }
  }, [nextCursor, loadingMore, listLoading, q, status, category, tag, flagged])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  // 以当时最新的地址栏为准（防抖期间改了状态 / 类型也不会被覆盖）。react-router 的函数式
  // setSearchParams 拿到的是创建它那次渲染的参数，防抖回调里用它会覆盖新筛选（跨应用联调发现），
  // 所以自己记住最新的参数。
  const latestParams = useRef(searchParams)
  useEffect(() => {
    latestParams.current = searchParams
  }, [searchParams])

  function updateFilters(patch: Partial<EnquiryFilters>) {
    const next = writeEnquiryFilters(latestParams.current, patch)
    latestParams.current = next
    setSearchParams(next, { replace: true })
  }

  // 与员工列表一致：输入停 300ms 后自动查询
  function onQueryChange(value: string) {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      updateFilters({ q: value })
    }, 300)
  }

  // 地址栏的 q 变了（返回、侧栏回到 /help-desk）：搜索框跟着变，正在输入时不打断
  useEffect(() => {
    setQuery((current) => resyncQuery(current, q, searchTimer.current !== null))
  }, [q])

  function select(id: string) {
    navigate({ pathname: `/${locale}/help-desk/${encodeURIComponent(id)}`, search: filterKey ? `?${filterKey}` : '' })
  }

  /* ---------------------------------- 详情 ---------------------------------- */

  /** 最新的工单详情：放进缓存，并同步左栏与时间线上那一行。 */
  const adopt = useCallback((detail: EnquiryDetail) => {
    setDetails((current) => ({ ...current, [detail.id]: detail }))
    setRows((current) => applyDetailToRow(current, detail))
    setTimeline((current) => (current ? { ...current, rows: applyDetailToRow(current.rows, detail) } : current))
  }, [])

  /** 取详情：结果总是放进缓存；只有员工还停在这条上时才返回 / 报错（切走了就不打扰）。 */
  const loadTicket = useCallback(
    async (id: string) => {
      const result = await getEnquiry(id)
      if (result.ok) adopt(result.data)
      if (currentTicket.current !== id) return null
      if (result.ok) {
        setDetailError(null)
        return result.data
      }
      setDetailError(result.code)
      return null
    },
    [adopt],
  )

  useEffect(() => {
    setNotice(null)
    setDetailError(null)
    // 在别的卡片上点 Email student / Internal notes：选中那张并保持面板展开
    setPanel((current) => (current && current.id === ticketId ? current : null))
    if (!ticketId) return
    let cancelled = false
    void (async () => {
      const detail = await loadTicket(ticketId)
      // 打开即已读（只对 FULL；VIEW 打开不清未读）。失败不打扰员工，下次打开再试。
      const markRead = !cancelled && detail ? markReadOnOpen(detail, canWrite) : null
      if (!detail || !markRead) return
      const result = await sendAction(detail.id, markRead, newIdempotencyKey())
      if (cancelled || currentTicket.current !== detail.id) return
      // 未读以 Portal 为准：失败时不在本地清除
      if (result.ok) adopt(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [ticketId, canWrite, loadTicket, adopt])

  // 学员时间线（Figma 1324:2 中栏）：选中工单的学员最多 10 条工单。每次打开一条工单都重新取
  // （学员刚提交的新工单也会出现）；取不到时保留这个学员上次取到的，没有就只显示选中的那张，失败不记住。
  useEffect(() => {
    if (!learnerId) return
    const id = ++timelineRequest.current
    void listTimeline(learnerId).then((result) => {
      if (id !== timelineRequest.current) return
      setTimeline((current) => {
        if (result.ok) return { learnerId, rows: result.data.tickets }
        return current?.learnerId === learnerId ? current : { learnerId, rows: [] }
      })
    })
  }, [learnerId, ticketId])

  // 时间线上其它卡片的详情（只读 GET，不调 mark_read）：Figma 1324:2 每张卡片都有正文、附件与 AI 块。
  // 最多 9 条（时间线上限 10），每条只取一次；点开时仍会重新取最新的。
  const prefetched = useRef<Set<string>>(new Set())
  const timelineIds = timeline ? timeline.rows.map((r) => r.id).join(' ') : ''
  useEffect(() => {
    if (!timelineIds) return
    for (const id of timelineIds.split(' ').slice(0, TIMELINE_LIMIT)) {
      // 选中的那条由上面的 loadTicket 负责
      if (prefetched.current.has(id) || id === currentTicket.current) continue
      prefetched.current.add(id)
      void getEnquiry(id).then((result) => {
        if (result.ok) adopt(result.data)
        else prefetched.current.delete(id)
      })
    }
  }, [timelineIds, adopt])

  /** 时间线上任意一张卡片的最新数据（操作栏用它的 sequence 与 available）。 */
  function findTicket(id: string): EnquiryRow | null {
    return details[id] ?? timeline?.rows.find((r) => r.id === id) ?? rows.find((r) => r.id === id) ?? null
  }

  /**
   * 写操作结果（只作用于发出请求的那条工单 id）：成功换成最新工单；409 stale 重新加载并提示；
   * 其它错误在那张卡片下提示一次。卡片已不在屏幕上（切到了别的学员）时只同步数据，不提示。
   */
  async function settle(result: HelpdeskResult<EnquiryDetail>, id: string): Promise<boolean> {
    const onScreen = () => visibleIds.current.has(id)
    const plan = settlePlan(result, id, onScreen() ? id : currentTicket.current)
    if (result.ok) adopt(result.data)
    if (plan.reload) {
      await loadTicket(id)
      if (!onScreen()) return false
    }
    if (plan.notice === 'clear') setNotice(null)
    else if (plan.notice === 'stale') setNotice({ id, kind: 'info', text: t(locale, 'helpDesk.stale') })
    else if (plan.notice === 'error' && !result.ok) setNotice({ id, kind: 'error', text: errorMessage(locale, result.code) })
    return plan.ok
  }

  /** 同一条工单上一次只跑一个写操作；结束时只清自己设的 busy。 */
  async function write(
    id: string,
    label: string,
    run: (id: string) => Promise<HelpdeskResult<EnquiryDetail>>,
  ): Promise<boolean> {
    if (visibleBusy(busy, id)) return false
    const mine: BusyToken = { label }
    setBusy((current) => startBusy(current, id, mine))
    const ok = await settle(await run(id), id)
    setBusy((current) => clearBusy(current, id, mine))
    return ok
  }

  function runAction(id: string, input: AgentActionInput, label: string): Promise<boolean> {
    return write(id, label, (target) => sendAction(target, input, newIdempotencyKey()))
  }

  async function claim(id: string) {
    const target = findTicket(id)
    if (target && (await runAction(id, claimInput(target), 'claim'))) {
      setNotice({ id, kind: 'info', text: t(locale, 'helpDesk.claimedNotice') })
    }
  }

  async function markReviewed(id: string) {
    const target = findTicket(id)
    if (target && (await runAction(id, { action: 'propose_resolution', expectedSequence: target.sequence }, 'review'))) {
      setNotice({ id, kind: 'info', text: t(locale, 'helpDesk.reviewedNotice') })
    }
  }

  async function toggleFlag(id: string) {
    const target = findTicket(id)
    if (!target) return
    const input = flagInput(target)
    if (await runAction(id, input, 'flag')) {
      setNotice({
        id,
        kind: 'info',
        text: t(locale, input.action === 'flag' ? 'helpDesk.flaggedNotice' : 'helpDesk.unflaggedNotice'),
      })
    }
  }

  function send(id: string, body: string, internal: boolean, key: string): Promise<boolean> {
    const target = findTicket(id)
    if (!target) return Promise.resolve(false)
    const expectedSequence = target.sequence
    return write(id, 'send', (target) => sendMessage(target, { body, internal, expectedSequence }, key))
  }

  function openPanel(next: Panel) {
    setPanel(next)
    if (next && next.id !== ticketId) select(next.id)
  }

  /* ---------------------------------- 渲染 ---------------------------------- */

  const controls = ticket ? enquiryControls(ticket, canWrite) : null
  const entries: TimelineEntry[] = ticket
    ? timelineCards<EnquiryRow>(ticket, timeline?.learnerId === ticket.learner.id ? timeline.rows : []).map((row) => ({
        row,
        detail: row.id === ticket.id ? ticket : (details[row.id] ?? null),
      }))
    : []
  const visibleKey = entries.map((entry) => entry.row.id).join(' ')
  useLayoutEffect(() => {
    visibleIds.current = new Set(visibleKey ? visibleKey.split(' ') : [])
  }, [visibleKey])

  if (listError === 'HELPDESK_NOT_CONNECTED' || detailError === 'HELPDESK_NOT_CONNECTED') {
    return <NotConnected locale={locale} />
  }

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
          <div className="hdConversation">
            <EnquiryTimeline
              locale={locale}
              learnerName={ticket.learner.name || ticket.learner.email}
              selectedId={ticket.id}
              entries={entries}
              canWrite={canWrite}
              notice={notice}
              busy={busy}
              panel={panel}
              onPanel={openPanel}
              onOpen={select}
              onClaim={(id) => void claim(id)}
              onMarkReviewed={(id) => void markReviewed(id)}
              onFlag={(id) => void toggleFlag(id)}
              onSend={send}
              drafts={drafts}
              onDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
              composerKeys={composerKeys}
            />
          </div>
          <StudentPanel
            key={`side-${ticket.id}`}
            locale={locale}
            ticket={ticket}
            editTags={controls.editTags}
            busy={visibleBusy(busy, ticket.id)}
            onAddTag={(value) =>
              runAction(ticket.id, { action: 'add_tag', tag: value, expectedSequence: ticket.sequence }, 'tag')
            }
            onRemoveTag={(value) =>
              void runAction(ticket.id, { action: 'remove_tag', tag: value, expectedSequence: ticket.sequence }, 'tag')
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
