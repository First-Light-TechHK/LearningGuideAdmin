import { useEffect, useRef } from 'react'

import {
  CONFIRM_WINDOW_HOURS,
  MESSAGE_BODY_MAX,
  type EnquiryDetail,
  type EnquiryRow,
  type TicketAiAssist,
  type TicketAttachment,
  type TicketMessage,
} from '../contracts/helpdesk'
import { attachmentUrl, newIdempotencyKey } from '../lib/helpdeskApi'
import { categoryLabel, statusLabel } from '../lib/helpdeskFormat'
import {
  TIMELINE_AVATAR,
  assistFeedbackTone,
  cardTime,
  composerKey,
  enquiryControls,
  enquiryTypeColor,
  fileSize,
  groupByDay,
  initials,
  isImeComposing,
  listTime,
  ratingValue,
  showTicketRating,
  splitNotes,
  splitThread,
  visibleBusy,
  type Busy,
  type ComposerKey,
} from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { MarkdownView } from './Markdown'
import { HdBotIcon } from './icons'

/**
 * 中栏：选中工单的学员时间线（Tickets v2 §3d，Figma 1324:2）。
 * 日期分隔 + 每条工单一张卡片（头像在卡片外；主题、类型、「联系邮箱 · HH:mm」、正文、附件、4 个按钮的操作栏），
 * 卡片后是它的 AI 块（aiAssist，每块一个只读的「查看链路」），选中的那条再往下是之后的对话。
 * 操作栏：Mark as reviewed（OPEN 时是 Claim / 接单）、Email student（展开回复框）、Internal notes
 * （展开内部备注与备注框）、Flag follow-up（开关）。VIEW 整个操作栏不显示，内部备注直接只读显示在对话里。
 * 回复框、备注面板、状态胶囊、按下态等没有画板的部分沿用同一套样式（待视觉验收）。
 */

export type Notice = { id: string; kind: 'error' | 'info'; text: string } | null
export type Panel = { id: string; kind: 'reply' | 'notes' } | null

/** 时间线上的一张卡片：列表行一定有；详情只有打开过的那些才有（选中的那张一定有）。 */
export type TimelineEntry = { row: EnquiryRow; detail: EnquiryDetail | null }

type Props = {
  locale: Locale
  learnerName: string
  selectedId: string
  entries: TimelineEntry[]
  canWrite: boolean
  notice: Notice
  busy: Busy
  panel: Panel
  /** 打开 / 收起回复框或备注面板；点的是别的卡片时，父组件同时选中那张。 */
  onPanel: (panel: Panel) => void
  onOpen: (id: string) => void
  onClaim: (id: string) => void
  onMarkReviewed: (id: string) => void
  onFlag: (id: string) => void
  /** 打开 AI 块的「查看链路」抽屉（run id = AI 块 id）。 */
  onTrace: (runId: string) => void
  /** idempotencyKey：同一份草稿重试沿用同一个，内容变了或发送成功后换新。 */
  onSend: (id: string, body: string, internal: boolean, idempotencyKey: string) => Promise<boolean>
  /** 回复 / 备注草稿与它们的 Idempotency-Key（按「工单 id:reply|note」），由父组件保存：中栏卸载也不丢。 */
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  composerKeys: { current: Record<string, ComposerKey | null> }
}

function Attachments({ files, locale }: { files: TicketAttachment[]; locale: Locale }) {
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
          <span aria-hidden="true">▣</span>
          <span className="hdFileName">{file.fileName}</span>
          {/* Figma 的附件胶囊只有文件名：大小留给读屏 */}
          <span className="hdSrOnly">{fileSize(file.size)}</span>
        </a>
      ))}
    </div>
  )
}

function MessageCard({ message, ticket, locale }: { message: TicketMessage; ticket: EnquiryRow; locale: Locale }) {
  if (message.authorKind === 'system') {
    return <div className="hdSystemLine">{message.body}</div>
  }
  const agent = message.authorKind === 'agent'
  const author =
    message.authorName ||
    (agent ? t(locale, 'helpDesk.message.support') : ticket.learner.name || t(locale, 'helpDesk.message.learner'))
  return (
    <div className={`hdMsgRow${agent ? ' hdMsgRowAgent' : ''}`}>
      <span
        className={`hdAvatar hdTimelineAvatar${agent ? ' hdAvatarAgent' : ''}`}
        style={agent ? undefined : { background: TIMELINE_AVATAR.bg, color: TIMELINE_AVATAR.fg }}
        aria-hidden="true"
      >
        {agent ? (author.trim()[0]?.toUpperCase() ?? '?') : initials(ticket.learner.name, ticket.learner.email)}
      </span>
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

function AiBlock({ assist, locale, onTrace }: { assist: TicketAiAssist; locale: Locale; onTrace: (runId: string) => void }) {
  const tone = assistFeedbackTone(assist.feedback)
  const rating = ratingValue(assist.rating)
  return (
    <div className="hdAiRow">
      <section className="hdAiBlock" aria-label={t(locale, 'helpDesk.ai.title')}>
        <header className="hdAiHead">
          <h3 className="hdAiTitle">{t(locale, 'helpDesk.ai.title')}</h3>
          <span className="hdAiTag">{t(locale, 'helpDesk.ai.tag')}</span>
          {/* 查看链路：只读，VIEW 角色也有（无画板，待视觉验收）；AI 块的 id 就是这次推荐的 run id */}
          <button type="button" className="hdLinkButton hdAiTrace" onClick={() => onTrace(assist.id)}>
            {t(locale, 'helpDesk.trace.view')}
          </button>
        </header>
        {assist.answer ? (
          <MarkdownView className="hdAiAnswer" text={assist.answer} />
        ) : (
          <p className="hdAiAnswer hdAiEmpty">{t(locale, 'helpDesk.ai.noAnswer')}</p>
        )}
        {tone ? (
          <p className={`hdAiFeedback ${tone === 'positive' ? 'hdAiFeedbackPositive' : 'hdAiFeedbackNegative'}`}>
            <span aria-hidden="true">{tone === 'positive' ? '✓' : '✕'}</span>{' '}
            {t(locale, tone === 'positive' ? 'helpDesk.ai.helpful' : 'helpDesk.ai.notHelpful')}
          </p>
        ) : null}
        {/* v3 §2：学员在「本次服务满意吗？」里给的星级；没评（或跳过）不显示。无画板，沿用反馈行样式（待视觉验收） */}
        {rating !== null ? <p className="hdAiRating">{t(locale, 'helpDesk.rating.value', { n: rating })}</p> : null}
      </section>
      <span className="hdBotAvatar" aria-hidden="true">
        <HdBotIcon />
      </span>
    </div>
  )
}

type ComposerProps = {
  locale: Locale
  internal: boolean
  hint: string
  draft: string
  busy: string | null
  onDraft: (value: string) => void
  onSend: (body: string, key: string) => Promise<boolean>
  /** 这份草稿上次发送用的 key（父组件保存，卸载再打开的重试仍沿用）。 */
  keyRef: { current: ComposerKey | null }
}

/** 一张卡片的回复框 / 备注框（无画板，待视觉验收）。草稿在 EnquiriesView 里，收起再展开、切换工单都不丢。 */
function Composer({ locale, internal, hint, draft, busy, onDraft, onSend, keyRef }: ComposerProps) {
  const trimmed = draft.trim()
  const tooLong = trimmed.length > MESSAGE_BODY_MAX

  async function submit() {
    if (busy || trimmed.length === 0 || tooLong) return
    // 同一份草稿重试沿用同一个 key，内容变了就换新
    keyRef.current = composerKey(keyRef.current, trimmed, internal, newIdempotencyKey)
    if (await onSend(trimmed, keyRef.current.key)) {
      onDraft('')
      keyRef.current = null
    }
  }

  const label = t(locale, internal ? 'helpDesk.composer.note' : 'helpDesk.composer.reply')
  return (
    <form
      className={`hdComposer${internal ? ' hdComposerNote' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="hdComposerHint">{hint}</p>
      <textarea
        className="hdTextarea"
        value={draft}
        autoFocus
        placeholder={t(locale, internal ? 'helpDesk.composer.notePlaceholder' : 'helpDesk.composer.replyPlaceholder')}
        aria-label={label}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isImeComposing(event)) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="hdComposerFoot">
        <span className={tooLong ? 'hdTooLong' : undefined}>
          {t(locale, 'helpDesk.composer.characters', { count: trimmed.length, max: MESSAGE_BODY_MAX })}
        </span>
        <button type="submit" className="hdPrimaryButton" disabled={busy !== null || trimmed.length === 0 || tooLong}>
          {busy === 'send' ? t(locale, 'helpDesk.composer.sending') : t(locale, 'helpDesk.composer.send')}
        </button>
      </div>
    </form>
  )
}

export function EnquiryTimeline(props: Props) {
  const { locale, entries, selectedId, canWrite, notice, busy, panel, drafts, composerKeys } = props
  /** 某份草稿的 key 存取（存在父组件的 ref 里）。 */
  const keyRefFor = (key: string) => ({
    get current() {
      return composerKeys.current[key] ?? null
    },
    set current(value: ComposerKey | null) {
      composerKeys.current[key] = value
    },
  })
  const selectedRef = useRef<HTMLElement | null>(null)
  const groups = groupByDay(
    entries.map((entry) => ({ ...entry, createdAt: entry.row.createdAt })),
    locale,
  )

  // 选中的工单滚到可见处（只滚中栏自身），跨应用联调发现的三处：
  // - 滚的是卡片本身而不是连同 AI 块与对话的整段：整段比中栏高时会被顶到最上面，
  //   把第一张卡片上方的日期分隔挡住；
  // - 等卡片真的渲染出来再滚：直接打开链接时卡片要等数据回来才出现，之前那次滚动落空；
  // - 它上面的卡片预取到详情（正文、AI 块）会变高，把选中的卡片挤出中栏，所以上面每多一张
  //   载好的卡片再滚一次（只在比上次滚时多的时候）；下面的卡片、刷新数据都不会再滚。
  const selectedIndex = entries.findIndex((entry) => entry.row.id === selectedId)
  const shown = selectedIndex >= 0
  const loadedAbove = shown ? entries.slice(0, selectedIndex).filter((entry) => entry.detail).length : 0
  const scrolledFor = useRef<{ id: string; above: number } | null>(null)
  useEffect(() => {
    if (!shown || !selectedRef.current) return
    const last = scrolledFor.current
    if (last && last.id === selectedId && last.above >= loadedAbove) return
    scrolledFor.current = { id: selectedId, above: loadedAbove }
    selectedRef.current.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId, shown, loadedAbove])

  function togglePanel(id: string, kind: 'reply' | 'notes') {
    const open = panel?.id === id && panel.kind === kind
    props.onPanel(open ? null : { id, kind })
  }

  return (
    <section className="hdThread hdTimeline" aria-label={t(locale, 'helpDesk.timeline.label', { name: props.learnerName })}>
      {groups.map((group) => (
        <div key={group.label} className="hdTimelineDay">
          <div className="hdDateSep">{group.label}</div>
          {group.cards.map(({ row, detail }) => {
            const ticket = detail ?? row
            const selected = row.id === selectedId
            const controls = enquiryControls(ticket, canWrite)
            const cardBusy = visibleBusy(busy, row.id)
            const messages = detail?.messages ?? []
            const { enquiry, rest } = splitThread(messages)
            const { notes, conversation } = splitNotes(rest)
            const body = detail ? (enquiry?.body ?? '') : row.preview
            const swatch = enquiryTypeColor(ticket.category)
            const replyOpen = panel?.id === row.id && panel.kind === 'reply'
            const notesOpen = panel?.id === row.id && panel.kind === 'notes'
            const draftKey = (kind: string) => `${row.id}:${kind}`
            const unavailable = t(locale, 'helpDesk.actions.unavailable')
            const reviewEnabled = controls.claim || controls.markReviewed
            const ticketRating = ratingValue(ticket.rating)
            return (
              <div
                key={row.id}
                className={`hdTimelineItem${selected ? ' hdTimelineItemCurrent' : ''}`}
              >
                <div className="hdMsgRow hdCardRow">
                  <span
                    className="hdAvatar hdTimelineAvatar"
                    style={{ background: TIMELINE_AVATAR.bg, color: TIMELINE_AVATAR.fg }}
                    aria-hidden="true"
                  >
                    {initials(ticket.learner.name, ticket.learner.email)}
                  </span>
                  <article
                    ref={selected ? selectedRef : undefined}
                    className={`hdEnquiryCard${selected ? ' hdEnquiryCardCurrent' : ''}`}
                    aria-label={ticket.subject}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <header className="hdCardHead">
                      <div className="hdCardTitleRow">
                        <h2 className="hdCardSubject">
                          {selected ? (
                            ticket.subject
                          ) : (
                            <button
                              type="button"
                              className="hdCardOpen"
                              title={t(locale, 'helpDesk.timeline.openCard')}
                              onClick={() => props.onOpen(row.id)}
                            >
                              {ticket.subject}
                            </button>
                          )}
                        </h2>
                        <span
                          className="hdTypeTag"
                          data-category={ticket.category}
                          style={{ background: swatch.bg, color: swatch.fg }}
                        >
                          {categoryLabel(locale, ticket.category)}
                        </span>
                      </div>
                      <div className="hdCardMetaRow">
                        <p className="hdCardMeta">
                          {ticket.contactEmail || ticket.learner.email} · {cardTime(row.createdAt, locale)}
                        </p>
                        {/* 状态：Figma 卡片上没有，放在 meta 行右侧，不挤占主题与类型（待视觉验收） */}
                        <span className={`hdStatusPill hdStatus${ticket.status}`}>{statusLabel(locale, ticket.status)}</span>
                        {/* v3 §2：学员给工单的评分「评分 n/5 / 未评分」，跟在状态胶囊后、同一套胶囊样式（无画板，待视觉验收） */}
                        {showTicketRating(ticket) ? (
                          <span className="hdStatusPill hdTicketRating">
                            {ticketRating === null
                              ? t(locale, 'helpDesk.rating.none')
                              : t(locale, 'helpDesk.rating.value', { n: ticketRating })}
                          </span>
                        ) : null}
                      </div>
                    </header>
                    <div className="hdDivider" />
                    {body ? <div className="hdBody">{body}</div> : null}
                    {enquiry && enquiry.attachments.length > 0 ? <Attachments files={enquiry.attachments} locale={locale} /> : null}
                    {controls.actionBar ? (
                      <>
                        <div className="hdDivider hdActionDivider" />
                        <div className="hdActionBar" role="group" aria-label={t(locale, 'helpDesk.actions.label')}>
                          {controls.claim ? (
                            <button
                              type="button"
                              className="hdActionButton"
                              title={t(locale, 'helpDesk.claimHint')}
                              disabled={cardBusy !== null}
                              onClick={() => props.onClaim(row.id)}
                            >
                              <span className="hdActionGlyph" aria-hidden="true">✓</span>{' '}
                              {cardBusy === 'claim' ? t(locale, 'helpDesk.claiming') : t(locale, 'helpDesk.claim')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="hdActionButton"
                              title={
                                reviewEnabled
                                  ? t(locale, 'helpDesk.markReviewedHint', { hours: CONFIRM_WINDOW_HOURS })
                                  : unavailable
                              }
                              disabled={!controls.markReviewed || cardBusy !== null}
                              onClick={() => props.onMarkReviewed(row.id)}
                            >
                              <span className="hdActionGlyph" aria-hidden="true">✓</span>{' '}
                              {t(locale, 'helpDesk.markReviewed')}
                            </button>
                          )}
                          <button
                            type="button"
                            className={`hdActionButton${replyOpen ? ' hdActionButtonOpen' : ''}`}
                            aria-expanded={replyOpen}
                            title={
                              controls.reply
                                ? t(locale, 'helpDesk.actions.emailHint', { email: ticket.contactEmail || ticket.learner.email })
                                : unavailable
                            }
                            disabled={!controls.reply}
                            onClick={() => togglePanel(row.id, 'reply')}
                          >
                            <span className="hdActionGlyph" aria-hidden="true">✉</span>{' '}
                            {t(locale, 'helpDesk.actions.emailStudent')}
                          </button>
                          <button
                            type="button"
                            className={`hdActionButton${notesOpen ? ' hdActionButtonOpen' : ''}`}
                            aria-expanded={notesOpen}
                            title={t(locale, 'helpDesk.actions.internalNotesHint')}
                            onClick={() => togglePanel(row.id, 'notes')}
                          >
                            <span className="hdActionGlyph" aria-hidden="true">▤</span>{' '}
                            {t(locale, 'helpDesk.actions.internalNotes')}
                          </button>
                          <button
                            type="button"
                            className={`hdActionButton${ticket.flagged ? ' hdActionButtonPressed' : ''}`}
                            aria-pressed={ticket.flagged}
                            title={
                              controls.flag
                                ? t(locale, ticket.flagged ? 'helpDesk.actions.unflagHint' : 'helpDesk.actions.flagHint')
                                : unavailable
                            }
                            disabled={!controls.flag || cardBusy !== null}
                            onClick={() => props.onFlag(row.id)}
                          >
                            <span className="hdActionGlyph" aria-hidden="true">⚑</span>{' '}
                            {t(locale, 'helpDesk.actions.flag')}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </article>
                </div>

                {notice && notice.id === row.id ? (
                  <div className={`alert ${notice.kind === 'error' ? 'alertError' : 'alertInfo'} hdNotice`} role="status">
                    {notice.text}
                  </div>
                ) : null}

                {(detail?.aiAssist ?? []).map((assist) => (
                  <AiBlock key={assist.id} assist={assist} locale={locale} onTrace={props.onTrace} />
                ))}

                {selected
                  ? (canWrite ? conversation : rest).map((message) => (
                      <MessageCard key={message.id} message={message} ticket={ticket} locale={locale} />
                    ))
                  : null}

                {replyOpen && controls.reply ? (
                  <Composer
                    locale={locale}
                    internal={false}
                    hint={t(locale, 'helpDesk.actions.emailHint', { email: ticket.contactEmail || ticket.learner.email })}
                    draft={drafts[draftKey('reply')] ?? ''}
                    busy={cardBusy}
                    keyRef={keyRefFor(draftKey('reply'))}
                    onDraft={(value) => props.onDraft(draftKey('reply'), value)}
                    onSend={(text, key) => props.onSend(row.id, text, false, key)}
                  />
                ) : null}

                {notesOpen && controls.actionBar ? (
                  <section className="hdNotesPanel" aria-label={t(locale, 'helpDesk.notes.title')}>
                    {detail === null ? (
                      <p className="hdMuted">{t(locale, 'common.loading')}</p>
                    ) : notes.length === 0 ? (
                      <p className="hdMuted">{t(locale, 'helpDesk.notes.empty')}</p>
                    ) : (
                      notes.map((message) => <MessageCard key={message.id} message={message} ticket={ticket} locale={locale} />)
                    )}
                    {controls.internalNote ? (
                      <Composer
                        locale={locale}
                        internal
                        hint={t(locale, 'helpDesk.actions.internalNotesHint')}
                        draft={drafts[draftKey('note')] ?? ''}
                        busy={cardBusy}
                        keyRef={keyRefFor(draftKey('note'))}
                        onDraft={(value) => props.onDraft(draftKey('note'), value)}
                        onSend={(text, key) => props.onSend(row.id, text, true, key)}
                      />
                    ) : null}
                  </section>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}
