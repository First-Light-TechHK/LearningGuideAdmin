import { useEffect, useRef, useState } from 'react'

import {
  CONFIRM_WINDOW_HOURS,
  MESSAGE_BODY_MAX,
  type EnquiryDetail,
  type TicketAttachment,
  type TicketMessage,
} from '../contracts/helpdesk'
import { attachmentUrl, newIdempotencyKey } from '../lib/helpdeskApi'
import { categoryLabel, statusLabel } from '../lib/helpdeskFormat'
import { dayLabel, fileSize, listTime, splitThread, type EnquiryControls } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { LearnerAvatar } from './EnquiryList'
import { HdCheckCircleIcon, HdFileIcon } from './icons'

/**
 * 中栏（Figma 1324:2 ConversationPanel）：日期分隔 + Enquiry 卡片（主题、类型、联系邮箱 · 时间、正文、
 * 附件、Mark as reviewed）+ 之后的消息 + 回复框。
 * 之后的消息、内部备注、状态胶囊与回复框没有 Figma 画板，沿用同一卡片样式（待视觉验收）。
 */

export type Notice = { kind: 'error' | 'info'; text: string } | null
type ComposerMode = 'reply' | 'note'

function Attachments({ files, locale }: { files: TicketAttachment[]; locale: Locale }) {
  if (files.length === 0) return <span />
  return (
    <div className="hdAttachments">
      {files.map((file) => (
        <a
          key={file.id}
          className="hdFileChip"
          href={attachmentUrl(file.id)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t(locale, 'helpDesk.message.attachment', { name: file.fileName })}
        >
          <HdFileIcon />
          <span className="hdFileText">
            <span className="hdFileName">{file.fileName}</span>
            <span className="hdFileSize">{fileSize(file.size)}</span>
          </span>
        </a>
      ))}
    </div>
  )
}

function MessageCard({ message, ticket, locale }: { message: TicketMessage; ticket: EnquiryDetail; locale: Locale }) {
  if (message.authorKind === 'system') {
    return <div className="hdSystemLine">{message.body}</div>
  }
  const agent = message.authorKind === 'agent'
  const author =
    message.authorName ||
    (agent ? t(locale, 'helpDesk.message.support') : ticket.learner.name || t(locale, 'helpDesk.message.learner'))
  const classes = ['hdMsgRow']
  if (agent) classes.push('hdMsgRowAgent')
  return (
    <div className={classes.join(' ')}>
      {agent ? (
        <span className="hdAvatar hdAvatarAgent" aria-hidden="true">
          {author.trim()[0]?.toUpperCase() ?? '?'}
        </span>
      ) : (
        <LearnerAvatar seed={ticket.learner.id || ticket.id} name={ticket.learner.name} email={ticket.learner.email} />
      )}
      <article className={`hdMsgCard${message.internal ? ' hdMsgCardInternal' : ''}${agent ? ' hdMsgCardAgent' : ''}`}>
        <div className="hdMsgMeta">
          <span className="hdMsgAuthor">{author}</span>
          {message.internal ? <span className="hdInternalTag">{t(locale, 'helpDesk.message.internalNote')}</span> : null}
          <time dateTime={message.createdAt}>{listTime(message.createdAt, locale)}</time>
        </div>
        {message.body ? <div className="hdBody">{message.body}</div> : null}
        {message.attachments.length > 0 ? <Attachments files={message.attachments} locale={locale} /> : null}
      </article>
    </div>
  )
}

type Props = {
  locale: Locale
  ticket: EnquiryDetail
  controls: EnquiryControls
  notice: Notice
  busy: string | null
  onMarkReviewed: () => void
  /** idempotencyKey：同一份草稿重试沿用同一个，草稿变了或发送成功后换新。 */
  onSend: (body: string, internal: boolean, idempotencyKey: string) => Promise<boolean>
}

export function EnquiryConversation({ locale, ticket, controls, notice, busy, onMarkReviewed, onSend }: Props) {
  const [mode, setMode] = useState<ComposerMode>('reply')
  const [draft, setDraft] = useState('')
  const threadRef = useRef<HTMLDivElement | null>(null)
  const draftKey = useRef<string | null>(null)
  const { enquiry, rest } = splitThread(ticket.messages)
  const effectiveMode: ComposerMode = !controls.reply && controls.internalNote ? 'note' : mode
  const trimmed = draft.trim()
  const tooLong = trimmed.length > MESSAGE_BODY_MAX

  useEffect(() => {
    // 只滚动对话区自身，不带动外层页面
    const thread = threadRef.current
    if (thread) thread.scrollTop = thread.scrollHeight
  }, [ticket.id, ticket.messages.length])

  async function submit() {
    if (busy || trimmed.length === 0 || tooLong) return
    if (!draftKey.current) draftKey.current = newIdempotencyKey()
    if (await onSend(trimmed, effectiveMode === 'note', draftKey.current)) {
      setDraft('')
      draftKey.current = null
    }
  }

  const day = dayLabel(enquiry?.createdAt ?? ticket.createdAt, locale)
  const dayText =
    day === null ? '' : day.kind === 'date' ? day.text : t(locale, day.kind === 'today' ? 'helpDesk.today' : 'helpDesk.yesterday')

  return (
    <div className="hdConversation">
      {notice ? (
        <div className={`alert ${notice.kind === 'error' ? 'alertError' : 'alertInfo'} hdNotice`} role="status">
          {notice.text}
        </div>
      ) : null}
      <div className="hdThread" ref={threadRef}>
        <div className="hdDateSep">{dayText}</div>
        <div className="hdMsgRow">
          <LearnerAvatar seed={ticket.learner.id || ticket.id} name={ticket.learner.name} email={ticket.learner.email} />
          <article className="hdEnquiryCard" aria-label={ticket.subject}>
            <header className="hdCardHead">
              <div className="hdCardTitleRow">
                <h2 className="hdCardSubject">{ticket.subject}</h2>
                <span className="hdTypeTag">{categoryLabel(locale, ticket.category)}</span>
                <span className={`hdStatusPill hdStatus${ticket.status}`}>{statusLabel(locale, ticket.status)}</span>
              </div>
              <p className="hdCardMeta">
                {ticket.contactEmail || ticket.learner.email} · {listTime(enquiry?.createdAt ?? ticket.createdAt, locale)}
              </p>
            </header>
            <div className="hdDivider" />
            {enquiry?.body ? <div className="hdBody">{enquiry.body}</div> : null}
            <div className="hdCardFoot">
              <Attachments files={enquiry?.attachments ?? []} locale={locale} />
              {controls.markReviewed ? (
                <button
                  type="button"
                  className="hdMarkReviewed"
                  title={t(locale, 'helpDesk.markReviewedHint', { hours: CONFIRM_WINDOW_HOURS })}
                  onClick={onMarkReviewed}
                  disabled={busy !== null}
                >
                  <HdCheckCircleIcon />
                  {t(locale, 'helpDesk.markReviewed')}
                </button>
              ) : null}
            </div>
          </article>
        </div>
        {rest.map((message) => (
          <MessageCard key={message.id} message={message} ticket={ticket} locale={locale} />
        ))}
      </div>

      {controls.composer ? (
        <form
          className={`hdComposer${effectiveMode === 'note' ? ' hdComposerNote' : ''}`}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="hdComposerModes" role="radiogroup">
            {controls.reply ? (
              <button
                type="button"
                role="radio"
                aria-checked={effectiveMode === 'reply'}
                className={`hdMode${effectiveMode === 'reply' ? ' hdModeActive' : ''}`}
                onClick={() => {
                  setMode('reply')
                  draftKey.current = null
                }}
              >
                {t(locale, 'helpDesk.composer.reply')}
              </button>
            ) : null}
            {controls.internalNote ? (
              <button
                type="button"
                role="radio"
                aria-checked={effectiveMode === 'note'}
                className={`hdMode${effectiveMode === 'note' ? ' hdModeActive' : ''}`}
                onClick={() => {
                  setMode('note')
                  draftKey.current = null
                }}
              >
                {t(locale, 'helpDesk.composer.note')}
              </button>
            ) : null}
          </div>
          <textarea
            className="hdTextarea"
            value={draft}
            placeholder={t(
              locale,
              effectiveMode === 'note' ? 'helpDesk.composer.notePlaceholder' : 'helpDesk.composer.replyPlaceholder',
            )}
            aria-label={t(locale, effectiveMode === 'note' ? 'helpDesk.composer.note' : 'helpDesk.composer.reply')}
            onChange={(event) => {
              setDraft(event.target.value)
              draftKey.current = null
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <div className="hdComposerFoot">
            <span>
              {effectiveMode === 'note' ? `${t(locale, 'helpDesk.composer.noteHint')} ` : ''}
              <span className={tooLong ? 'hdTooLong' : undefined}>
                {t(locale, 'helpDesk.composer.characters', { count: trimmed.length, max: MESSAGE_BODY_MAX })}
              </span>
            </span>
            <button
              type="submit"
              className="hdPrimaryButton"
              disabled={busy !== null || trimmed.length === 0 || tooLong}
            >
              {busy === 'send' ? t(locale, 'helpDesk.composer.sending') : t(locale, 'helpDesk.composer.send')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
