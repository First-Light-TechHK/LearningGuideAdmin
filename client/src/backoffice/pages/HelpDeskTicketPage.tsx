import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import '../helpdesk.css'
import { ChevronLeftIcon } from '../components/icons'
import {
  CONFIRM_WINDOW_HOURS,
  MESSAGE_BODY_MAX,
  type AgentAction,
  type BoardTicketDetail,
  type TicketMessage,
} from '../contracts/helpdesk'
import {
  attachmentUrl,
  getTicket,
  newIdempotencyKey,
  sendAction,
  sendMessage,
  type HelpdeskResult,
} from '../lib/helpdeskApi'
import {
  absoluteTime,
  categoryLabel,
  closeReasonLabel,
  errorMessage,
  eventLabel,
  localeName,
  relativeTime,
} from '../lib/helpdeskFormat'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { useWorkspaceAccess } from '../lib/workspaceAccess'
import { NotConnectedCard, TicketStatusPill } from './HelpDeskPage'

/**
 * 工单详情（设计文档 §4A.4）：对话（内部备注单独样式）+ 右栏学员信息 / 状态 / 时间线。
 * 操作（认领、回复、内部备注、请学员确认）只对 helpDesk = FULL 的角色显示；
 * 服务端同样拒绝只读角色的写请求。
 */

type Notice = { kind: 'error' | 'info'; text: string } | null
type ComposerMode = 'reply' | 'note'

function MessageItem({ message, locale }: { message: TicketMessage; locale: Locale }) {
  if (message.authorKind === 'system') {
    return <div className="hdSystemLine">{message.body}</div>
  }
  const isAgent = message.authorKind === 'agent'
  const classes = ['hdMessage']
  if (isAgent) classes.push('hdMessageAgent')
  if (message.internal) classes.push('hdMessageInternal')
  return (
    <article className={classes.join(' ')}>
      <div className="hdMessageMeta">
        <span className="hdMessageAuthor">
          {message.authorName || (isAgent ? t(locale, 'nav.helpDesk') : t(locale, 'helpDesk.detail.learner'))}
        </span>
        {message.internal ? <span className="hdInternalTag">{t(locale, 'helpDesk.detail.internalNote')}</span> : null}
        <time dateTime={message.createdAt} title={absoluteTime(message.createdAt, locale)}>
          {relativeTime(message.createdAt, locale)}
        </time>
      </div>
      {message.body ? <div className="hdBubble">{message.body}</div> : null}
      {message.attachments.length > 0 ? (
        <div className="hdAttachments">
          {message.attachments.map((file) => (
            <a
              key={file.id}
              className="hdThumb"
              href={attachmentUrl(file.id)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(locale, 'helpDesk.detail.attachment', { name: file.fileName })}
            >
              <img src={attachmentUrl(file.id)} alt={file.fileName} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
    </article>
  )
}

function SidePanel({ ticket, locale }: { ticket: BoardTicketDetail; locale: Locale }) {
  const facts: [string, string][] = [
    [t(locale, 'helpDesk.detail.learner'), ticket.learner.name || '—'],
    [t(locale, 'helpDesk.detail.email'), ticket.learner.email || '—'],
    [t(locale, 'helpDesk.detail.language'), localeName(locale, ticket.locale)],
    [t(locale, 'helpDesk.detail.category'), categoryLabel(locale, ticket.category)],
    [t(locale, 'helpDesk.detail.assignee'), ticket.assignee?.name || t(locale, 'helpDesk.unassigned')],
    [t(locale, 'helpDesk.detail.created'), absoluteTime(ticket.createdAt, locale)],
    [t(locale, 'helpDesk.detail.lastUpdate'), absoluteTime(ticket.lastMessageAt ?? ticket.updatedAt, locale)],
  ]
  if (ticket.status === 'PENDING_CONFIRM' && ticket.confirmDueAt) {
    facts.push([
      t(locale, 'helpDesk.detail.confirmDue'),
      `${absoluteTime(ticket.confirmDueAt, locale)} (${relativeTime(ticket.confirmDueAt, locale)})`,
    ])
  }
  if (ticket.closeReason) {
    facts.push([t(locale, 'helpDesk.detail.closeReason'), closeReasonLabel(locale, ticket.closeReason)])
  }
  if (ticket.rating !== null) {
    facts.push([t(locale, 'helpDesk.detail.rating'), t(locale, 'helpDesk.detail.ratingValue', { rating: ticket.rating })])
  }
  const events = [...ticket.events].sort((a, b) => a.sequence - b.sequence)
  return (
    <aside className="card hdSide">
      <section>
        <h2 className="hdSideTitle">{t(locale, 'helpDesk.detail.status')}</h2>
        <TicketStatusPill locale={locale} status={ticket.status} />
      </section>
      <section>
        <dl className="hdFacts">
          {facts.map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2 className="hdSideTitle">{t(locale, 'helpDesk.detail.timeline')}</h2>
        {events.length === 0 ? (
          <p className="cardSubtitle">{t(locale, 'helpDesk.detail.noEvents')}</p>
        ) : (
          <ol className="hdTimeline">
            {events.map((event) => (
              <li key={event.id}>
                {eventLabel(locale, event.type)}
                {event.data.actor?.name ? ` · ${event.data.actor.name}` : ''}
                <time className="hdTimelineTime" dateTime={event.time}>
                  {absoluteTime(event.time, locale)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  )
}

export default function HelpDeskTicketPage() {
  const locale = useLocale()
  const access = useWorkspaceAccess()
  // PRD §3.2：VIEW 只读——不渲染任何操作控件
  const canWrite = access.canCreate
  const { ticketId = '' } = useParams<{ ticketId: string }>()

  const [ticket, setTicket] = useState<BoardTicketDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<AgentAction | 'send' | null>(null)
  const [mode, setMode] = useState<ComposerMode>('reply')
  const [draft, setDraft] = useState('')
  // 同一份草稿重试沿用同一个 Idempotency-Key；草稿变了或发送成功后换新
  const draftKey = useRef<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    const result = await getTicket(ticketId)
    if (result.ok) {
      setTicket(result.data)
      setLoadError(null)
    } else {
      setLoadError(result.code)
    }
    return result
  }, [ticketId])

  useEffect(() => {
    setTicket(null)
    setNotice(null)
    void load()
  }, [load])

  const messageCount = ticket?.messages.length ?? 0
  useEffect(() => {
    // 只滚动对话区自身，不带动外层页面
    const thread = threadRef.current
    if (thread) thread.scrollTop = thread.scrollHeight
  }, [messageCount])

  // 只能回复不能备注、或反之时，自动切到可用的那一种
  const available = ticket?.available
  const effectiveMode: ComposerMode =
    available && !available.reply && available.internalNote ? 'note' : mode

  /** 写操作结果：成功换成最新工单；409 stale 重新加载并提示；其它错误内联显示一次。 */
  async function settle(result: HelpdeskResult<BoardTicketDetail>): Promise<boolean> {
    if (result.ok) {
      setTicket(result.data)
      setNotice(null)
      return true
    }
    if (result.code === 'STALE_TICKET') {
      await load()
      setNotice({ kind: 'info', text: t(locale, 'helpDesk.detail.stale') })
      return false
    }
    setNotice({ kind: 'error', text: errorMessage(locale, result.code) })
    return false
  }

  async function runAction(action: AgentAction) {
    if (!ticket || busy) return
    setBusy(action)
    const result = await sendAction(ticket.id, { action, expectedSequence: ticket.sequence }, newIdempotencyKey())
    await settle(result)
    setBusy(null)
  }

  async function send() {
    if (!ticket || busy) return
    const body = draft.trim()
    if (body.length === 0 || body.length > MESSAGE_BODY_MAX) return
    if (!draftKey.current) draftKey.current = newIdempotencyKey()
    setBusy('send')
    const result = await sendMessage(
      ticket.id,
      { body, internal: effectiveMode === 'note', expectedSequence: ticket.sequence },
      draftKey.current,
    )
    if (await settle(result)) {
      setDraft('')
      draftKey.current = null
    }
    setBusy(null)
  }

  if (loadError === 'HELPDESK_NOT_CONNECTED') return <NotConnectedCard locale={locale} />

  const backLink = (
    <Link className="hdBack" to={`/${locale}/help-desk`}>
      <ChevronLeftIcon />
      {t(locale, 'helpDesk.detail.back')}
    </Link>
  )

  if (!ticket) {
    return (
      <section className="card cardGrow">
        {backLink}
        {loadError === 'TICKET_NOT_FOUND' || loadError === 'INVALID_INPUT' ? (
          <>
            <h1 className="cardTitle">{t(locale, 'helpDesk.detail.notFoundTitle')}</h1>
            <p className="cardBody">{t(locale, 'helpDesk.detail.notFoundBody')}</p>
          </>
        ) : loadError ? (
          <>
            <div className="alert alertError" role="alert">
              {errorMessage(locale, loadError)}
            </div>
            <p>
              <button type="button" className="button buttonGhost buttonCompact" onClick={() => void load()}>
                {t(locale, 'common.retry')}
              </button>
            </p>
          </>
        ) : (
          <p className="cardBody">{t(locale, 'common.loading')}</p>
        )}
      </section>
    )
  }

  const actions = ticket.available
  const showComposer = canWrite && (actions.reply || actions.internalNote)
  const tooLong = draft.trim().length > MESSAGE_BODY_MAX

  return (
    <>
      <section className="card cardGrow">
        {backLink}
        <div className="pageHead" style={{ marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div className="hdHeadMeta">
              <span className="hdNumber">{ticket.number}</span>
              <TicketStatusPill locale={locale} status={ticket.status} />
              {ticket.needsReply ? <span className="hdBadge">{t(locale, 'helpDesk.needsReply')}</span> : null}
            </div>
            <h1 className="cardTitle">{ticket.subject}</h1>
          </div>
          <div className="hdHeadActions">
            <button
              type="button"
              className="button buttonGhost buttonCompact"
              onClick={() => void load()}
              disabled={busy !== null}
            >
              {t(locale, 'helpDesk.refresh')}
            </button>
            {canWrite && actions.claim ? (
              <button
                type="button"
                className="button buttonCompact"
                onClick={() => void runAction('claim')}
                disabled={busy !== null}
              >
                {t(locale, 'helpDesk.detail.claim')}
              </button>
            ) : null}
            {canWrite && actions.proposeResolution ? (
              <button
                type="button"
                className="button buttonCompact"
                title={t(locale, 'helpDesk.detail.proposeHint', { hours: CONFIRM_WINDOW_HOURS })}
                onClick={() => void runAction('propose_resolution')}
                disabled={busy !== null}
              >
                {t(locale, 'helpDesk.detail.propose')}
              </button>
            ) : null}
          </div>
        </div>

        {notice ? (
          <div className={`alert ${notice.kind === 'error' ? 'alertError' : 'alertInfo'}`} role="status">
            {notice.text}
          </div>
        ) : null}

        <div className="hdThread" ref={threadRef}>
          {ticket.messages.length === 0 ? (
            <p className="hdEmpty">{t(locale, 'helpDesk.detail.noMessages')}</p>
          ) : (
            ticket.messages.map((message) => <MessageItem key={message.id} message={message} locale={locale} />)
          )}
        </div>

        {showComposer ? (
          <form
            className={`hdComposer${effectiveMode === 'note' ? ' hdComposerInternal' : ''}`}
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <div className="segmented" role="radiogroup">
              {actions.reply ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === 'reply'}
                  className={`segment${effectiveMode === 'reply' ? ' segmentSelected' : ''}`}
                  onClick={() => setMode('reply')}
                >
                  {t(locale, 'helpDesk.detail.replyMode')}
                </button>
              ) : null}
              {actions.internalNote ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === 'note'}
                  className={`segment${effectiveMode === 'note' ? ' segmentSelected' : ''}`}
                  onClick={() => setMode('note')}
                >
                  {t(locale, 'helpDesk.detail.noteMode')}
                </button>
              ) : null}
            </div>
            <textarea
              className="hdTextarea"
              value={draft}
              placeholder={t(
                locale,
                effectiveMode === 'note' ? 'helpDesk.detail.notePlaceholder' : 'helpDesk.detail.replyPlaceholder',
              )}
              aria-label={t(locale, effectiveMode === 'note' ? 'helpDesk.detail.noteMode' : 'helpDesk.detail.replyMode')}
              onChange={(event) => {
                setDraft(event.target.value)
                draftKey.current = null
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="hdComposerFoot">
              <span>
                {effectiveMode === 'note' ? `${t(locale, 'helpDesk.detail.noteHint')} ` : ''}
                <span style={tooLong ? { color: 'var(--lg-red)' } : undefined}>
                  {t(locale, 'helpDesk.detail.characters', { count: draft.trim().length, max: MESSAGE_BODY_MAX })}
                </span>
              </span>
              <button
                type="submit"
                className="button buttonCompact"
                disabled={busy !== null || draft.trim().length === 0 || tooLong}
              >
                {busy === 'send' ? t(locale, 'helpDesk.detail.sending') : t(locale, 'helpDesk.detail.send')}
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <SidePanel ticket={ticket} locale={locale} />
    </>
  )
}
