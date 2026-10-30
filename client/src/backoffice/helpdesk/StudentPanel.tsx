import { useEffect, useId, useRef, useState } from 'react'

import type { EnquiryDetail, TicketOrder } from '../contracts/helpdesk'
import {
  billingCycleLabel,
  formatOrderAmount,
  orderStatusLabel,
  paymentModeLabel,
  subscriptionStatusLabel,
} from '../lib/helpdeskFormat'
import {
  isImeComposing,
  longDate,
  orderTone,
  subscriptionTone,
  tagAddError,
  tagColor,
  normalizeTag,
} from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdCalendarIcon, HdCloseIcon, HdReceiptIcon } from './icons'

/**
 * 右栏 387px（Figma 1324:2 RightSidebar）：学员信息、当前订阅、（v4）订单、标签。
 * 只读投影来自 Portal；标签增删只给 FULL（editTags）。
 */

type Props = {
  locale: Locale
  ticket: EnquiryDetail
  editTags: boolean
  busy: string | null
  onAddTag: (tag: string) => Promise<boolean>
  onRemoveTag: (tag: string) => void
}

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'link' | 'small' }) {
  return (
    <div className="hdFact">
      <dt>{label}</dt>
      <dd className={tone === 'link' ? 'hdFactLink' : tone === 'small' ? 'hdFactSmall' : undefined}>{children}</dd>
    </div>
  )
}

function TagEditor({
  locale,
  tags,
  busy,
  onAdd,
  onCancel,
}: {
  locale: Locale
  tags: string[]
  busy: boolean
  onAdd: (tag: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    const problem = tagAddError(tags, value)
    if (problem) {
      setError(t(locale, `helpDesk.tags.${problem}`))
      return
    }
    if (await onAdd(normalizeTag(value) as string)) {
      setValue('')
      setError(null)
      onCancel()
    }
  }
  return (
    <div className="hdTagEditor">
      <input
        autoFocus
        value={value}
        maxLength={64}
        placeholder={t(locale, 'helpDesk.tags.placeholder')}
        aria-label={t(locale, 'helpDesk.tags.placeholder')}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          // 输入法组字时的 Enter / Esc 属于输入法
          if (isImeComposing(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
          } else if (event.key === 'Escape') {
            onCancel()
          }
        }}
      />
      {error ? <p className="hdFieldError">{error}</p> : null}
    </div>
  )
}

/**
 * v4 Part A「订单 / Order」块（helpdesk-v4-order-and-chat-end.md）：紧跟订阅块，沿用订阅块的行样式。
 * 无 Figma 画板，待视觉验收。只有工单关联了订单才出现；Portal 这次没读到订单（order 为 null）时
 * 仍显示订单号与复制，其余为 —。
 * 不链到订单页：BackOffice 的 Order Management 还是占位页，Portal 的订单页也不能按地址打开某个订单，
 * 所以只给订单号 + 复制。
 */
function OrderBlock({ locale, orderId, order }: { locale: Locale; orderId: string; order: TicketOrder | null }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'fallback'>('idle')
  const numberRef = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleId = useId()
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function copyNumber() {
    if (timer.current) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(orderId)
      setCopy('copied')
      timer.current = setTimeout(() => setCopy('idle'), 2000)
    } catch {
      // 浏览器拒绝剪贴板时退化为选中订单号，员工自己按 Ctrl/Cmd+C（与员工账号页的复制链接一致）
      const node = numberRef.current
      const selection = window.getSelection()
      if (node && selection) {
        const range = document.createRange()
        range.selectNodeContents(node)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      setCopy('fallback')
    }
  }

  const status = order?.status ?? null
  return (
    <section className="hdSideSection" aria-labelledby={titleId}>
      <h3 className="hdSectionTitle hdSectionTitleIcon" id={titleId}>
        <HdReceiptIcon />
        {t(locale, 'helpDesk.order.title')}
      </h3>
      <dl className="hdPlan">
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.number')}</dt>
          <dd className="hdOrderNumberCell">
            <span className="hdOrderNumber" ref={numberRef}>
              {orderId}
            </span>
            <button
              type="button"
              className="hdLinkButton"
              aria-label={t(locale, 'helpDesk.order.copyLabel', { id: orderId })}
              onClick={() => void copyNumber()}
            >
              {t(locale, copy === 'copied' ? 'helpDesk.order.copied' : 'helpDesk.order.copy')}
            </button>
          </dd>
        </div>
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.status')}</dt>
          <dd>
            {status ? (
              <span className={`hdPill hdPill-${orderTone(status)}`}>{orderStatusLabel(locale, status)}</span>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.amount')}</dt>
          <dd>{formatOrderAmount(locale, order?.amount, order?.currency)}</dd>
        </div>
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.plan')}</dt>
          <dd>{order?.planName || '—'}</dd>
        </div>
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.date')}</dt>
          <dd>{longDate(order?.createdAt, locale)}</dd>
        </div>
        <div className="hdPlanRow">
          <dt>{t(locale, 'helpDesk.order.paymentMode')}</dt>
          <dd>{order?.paymentMode ? paymentModeLabel(locale, order.paymentMode) : '—'}</dd>
        </div>
      </dl>
      {order === null ? <p className="hdMuted">{t(locale, 'helpDesk.order.unavailable')}</p> : null}
      <p className="hdNotice hdOrderCopyNotice" role="status">
        {copy === 'copied'
          ? t(locale, 'helpDesk.order.copiedNotice')
          : copy === 'fallback'
            ? t(locale, 'helpDesk.order.copyFallback')
            : ''}
      </p>
    </section>
  )
}

export function StudentPanel({ locale, ticket, editTags, busy, onAddTag, onRemoveTag }: Props) {
  const [adding, setAdding] = useState(false)
  const student = ticket.student
  const name = student?.name || ticket.learner.name || ticket.learner.email
  const accountEmail = student?.accountEmail || ticket.learner.email
  const contactEmail = student?.contactEmail ?? ticket.contactEmail
  const plan = ticket.subscription
  const tone = plan ? subscriptionTone(plan.status) : 'neutral'

  return (
    <aside className="hdSide" aria-label={t(locale, 'helpDesk.student.title')}>
      <section className="hdSideSection hdSideFirst">
        <h2 className="hdStudentName">{name}</h2>
        {accountEmail ? (
          <a className="hdStudentEmail" href={`mailto:${accountEmail}`}>
            {accountEmail}
          </a>
        ) : null}
        <h3 className="hdSectionTitle">{t(locale, 'helpDesk.student.title')}</h3>
        <dl className="hdFacts">
          <Fact label={t(locale, 'helpDesk.student.accountEmail')}>{accountEmail || '—'}</Fact>
          <Fact label={t(locale, 'helpDesk.student.contactEmail')} tone={contactEmail ? 'link' : undefined}>
            {contactEmail || '—'}
          </Fact>
          <Fact label={t(locale, 'helpDesk.student.joinedAt')}>{longDate(student?.joinedAt, locale)}</Fact>
          <Fact label={t(locale, 'helpDesk.student.id')} tone="small">
            {student?.id || ticket.learner.id || '—'}
          </Fact>
          <Fact label={t(locale, 'helpDesk.student.totalEnquiries')}>
            {student?.totalEnquiries ?? '—'}
          </Fact>
          <Fact label={t(locale, 'helpDesk.student.currentCourse')}>{student?.currentCourse?.title || '—'}</Fact>
        </dl>
      </section>

      <section className="hdSideSection">
        <h3 className="hdSectionTitle hdSectionTitleIcon">
          <HdCalendarIcon />
          {t(locale, 'helpDesk.subscription.title')}
        </h3>
        <dl className="hdPlan">
          <div className="hdPlanRow">
            <dt>{t(locale, 'helpDesk.subscription.planName')}</dt>
            <dd>{plan?.planName || '—'}</dd>
          </div>
          <div className="hdPlanRow">
            <dt>{t(locale, 'helpDesk.subscription.billingCycle')}</dt>
            <dd>{plan?.billingCycle ? billingCycleLabel(locale, plan.billingCycle) : '—'}</dd>
          </div>
          <div className="hdPlanRow">
            <dt>{t(locale, 'helpDesk.subscription.status')}</dt>
            <dd>
              {plan?.status ? (
                <span className={`hdPill hdPill-${tone}`}>{subscriptionStatusLabel(locale, plan.status)}</span>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="hdPlanRow">
            <dt>{t(locale, 'helpDesk.subscription.renewalDate')}</dt>
            <dd>{longDate(plan?.renewalDate, locale)}</dd>
          </div>
        </dl>
      </section>

      {ticket.orderId ? <OrderBlock locale={locale} orderId={ticket.orderId} order={ticket.order ?? null} /> : null}

      <section className="hdSideSection hdTagsSection">
        <div className="hdTagsHead">
          <h3 className="hdSectionTitle">{t(locale, 'helpDesk.tags.title')}</h3>
          {editTags && !adding ? (
            <button type="button" className="hdAddTag" onClick={() => setAdding(true)} disabled={busy !== null}>
              ＋ {t(locale, 'helpDesk.tags.add')}
            </button>
          ) : null}
        </div>
        {adding && editTags ? (
          <TagEditor
            locale={locale}
            tags={ticket.tags}
            busy={busy !== null}
            onAdd={onAddTag}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {ticket.tags.length === 0 ? (
          <p className="hdMuted">{t(locale, 'helpDesk.tags.empty')}</p>
        ) : (
          <ul className="hdTagList">
            {ticket.tags.map((tag, index) => {
              const colour = tagColor(index)
              return (
                <li key={tag} className="hdTag" style={{ background: colour.bg, color: colour.fg }}>
                  {tag}
                  {editTags ? (
                    <button
                      type="button"
                      className="hdTagRemove"
                      aria-label={t(locale, 'helpDesk.tags.remove', { tag })}
                      disabled={busy !== null}
                      onClick={() => onRemoveTag(tag)}
                    >
                      <HdCloseIcon />
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </aside>
  )
}
