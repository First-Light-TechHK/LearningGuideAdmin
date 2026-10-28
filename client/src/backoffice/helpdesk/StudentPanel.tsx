import { useState } from 'react'

import type { EnquiryDetail } from '../contracts/helpdesk'
import { billingCycleLabel, subscriptionStatusLabel } from '../lib/helpdeskFormat'
import { longDate, subscriptionTone, tagAddError, tagColor, normalizeTag } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdCalendarIcon, HdCloseIcon } from './icons'

/**
 * 右栏 387px（Figma 1324:2 RightSidebar）：学员信息、当前订阅、标签。
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
            {ticket.tags.map((tag) => {
              const colour = tagColor(tag)
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
