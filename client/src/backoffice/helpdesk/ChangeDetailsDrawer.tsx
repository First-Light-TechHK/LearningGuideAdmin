import { useEffect, useId, useRef, type ReactNode } from 'react'

import type { FaqChange, FaqFieldChange } from '../contracts/helpdesk'
import {
  actionLabel,
  actionTone,
  changeDateTime,
  changeTitle,
  fieldLabel,
  fieldValue,
  isListField,
  isTextField,
  learnersLine,
  listDiff,
  personName,
  personRole,
  subjectLabel,
  textDiff,
  viewerTimeZone,
} from '../lib/helpdeskChanges'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useModal } from './useModal'

/**
 * 改动详情（Figma 草案 2.7）：谁、什么时候（带时区）、哪一种改动与版本号、用户是否已看到；下面逐字段的改前改后：
 * 长文字标出改了的那一段（红 = 删掉的，绿 = 加上的），关键词 / 情境是 − / + 小标签，其它是「改前 → 改后」。
 * 「Open this FAQ」交给页面（FULL 打开编辑抽屉，VIEW 打开预览）；FAQ 已删除时不给。
 * ChangeDiff 也用在 FAQ 抽屉的 History（2.8）里展开的那一段。
 */

function ListChange({ locale, change }: { locale: Locale; change: FaqFieldChange }) {
  const diff = listDiff(change.before, change.after)
  const label = (item: string) => (change.field === 'signals' ? fieldValue(locale, 'signals', [item]) : item)
  return (
    <div className="hdDiffField">
      <div className="hdDiffLabel">
        {t(locale, 'helpDesk.changes.details.listChanges', {
          field: fieldLabel(locale, change.field),
        })}
      </div>
      <ul className="hdDiffChips">
        {diff.kept.map((item) => (
          <li key={`k-${item}`} className="hdDiffChip">
            {label(item)}
          </li>
        ))}
        {diff.removed.map((item) => (
          <li key={`r-${item}`} className="hdDiffChip hdDiffChipRemoved">
            <span aria-hidden="true">− </span>
            <del>{label(item)}</del>
          </li>
        ))}
        {diff.added.map((item) => (
          <li key={`a-${item}`} className="hdDiffChip hdDiffChipAdded">
            <span aria-hidden="true">+ </span>
            <ins>{label(item)}</ins>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TextChange({ locale, change }: { locale: Locale; change: FaqFieldChange }) {
  const before = typeof change.before === 'string' ? change.before : ''
  const after = typeof change.after === 'string' ? change.after : ''
  const diff = textDiff(before, after)
  const block = (kind: 'before' | 'after', parts: typeof diff.before, empty: boolean) => (
    <div className={`hdDiffText hdDiffText-${kind}`}>
      <div className="hdDiffSide">{t(locale, `helpDesk.changes.details.${kind}`)}</div>
      <p className="hdDiffBody">
        {empty
          ? t(locale, 'helpDesk.changes.empty_value')
          : parts.map((part, index) =>
              part.changed ? (
                kind === 'before' ? (
                  <del key={index} className="hdDiffRemoved">
                    {part.text}
                  </del>
                ) : (
                  <ins key={index} className="hdDiffAdded">
                    {part.text}
                  </ins>
                )
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
      </p>
    </div>
  )
  return (
    <div className="hdDiffField">
      <div className="hdDiffLabel">{fieldLabel(locale, change.field)}</div>
      {change.before !== null && change.before !== undefined ? block('before', diff.before, before === '') : null}
      {block('after', diff.after, after === '')}
    </div>
  )
}

function ValueChange({ locale, change }: { locale: Locale; change: FaqFieldChange }) {
  const created = change.before === null || change.before === undefined
  return (
    <div className="hdDiffField">
      <div className="hdDiffLabel">{fieldLabel(locale, change.field)}</div>
      <p className="hdDiffValue">
        {created ? null : (
          <>
            <del className="hdDiffRemoved">{fieldValue(locale, change.field, change.before)}</del>
            <span className="hdDiffArrow" aria-hidden="true">
              {' → '}
            </span>
          </>
        )}
        <ins className="hdDiffAdded">{fieldValue(locale, change.field, change.after)}</ins>
      </p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hdDiffField">
      <div className="hdDiffLabel">{label}</div>
      <p className="hdDiffValue">{children}</p>
    </div>
  )
}

/** 一条改动「改了什么」的内容（详情抽屉与 History 展开共用）。 */
export function ChangeDiff({ locale, change }: { locale: Locale; change: FaqChange }) {
  const d = (key: string, values?: Record<string, string | number>) => t(locale, `helpDesk.changes.details.${key}`, values)
  if (change.subject === 'phrasing' && change.phrasing) {
    const p = change.phrasing
    return (
      <div className="hdDiff">
        <Row label={d('phrasing')}>
          {change.action === 'removed' ? <del className="hdDiffRemoved">{p.text}</del> : <ins className="hdDiffAdded">{p.text}</ins>}
        </Row>
        <Row label={d('language')}>{t(locale, `helpDesk.graph.phrasingLocales.${p.locale}`)}</Row>
        <Row label={d('source')}>{t(locale, `helpDesk.changes.details.sources.${p.source === 'flywheel' ? 'flywheel' : 'staff'}`)}</Row>
      </div>
    )
  }
  if (change.subject === 'release' && change.release) {
    const r = change.release
    return (
      <div className="hdDiff">
        <Row label={d('release')}>{t(locale, 'helpDesk.changes.version', { version: r.version })}</Row>
        {r.sourceVersion !== null ? (
          <Row label={d('releaseFrom')}>
            {t(locale, 'helpDesk.changes.version', {
              version: r.sourceVersion,
            })}
          </Row>
        ) : null}
        {change.action === 'version_created' || change.action === 'rolled_back' ? <Row label={d('problems')}>{r.problems}</Row> : null}
      </div>
    )
  }
  const zh = locale === 'zh-CN'
  const question = (node: FaqChange['faq']) => (node ? (zh ? node.questionZh : node.questionEn) : '')
  return (
    <div className="hdDiff">
      {change.subject === 'follow_up' || change.subject === 'option' ? (
        <>
          <Row label={d('parent')}>{question(change.faq)}</Row>
          <Row label={d('child')}>{question(change.child)}</Row>
        </>
      ) : null}
      {change.changes.map((field) =>
        isListField(field.field) ? (
          <ListChange key={field.field} locale={locale} change={field} />
        ) : isTextField(field.field) && (typeof field.before === 'string' || typeof field.after === 'string') ? (
          <TextChange key={field.field} locale={locale} change={field} />
        ) : (
          <ValueChange key={field.field} locale={locale} change={field} />
        ),
      )}
    </div>
  )
}

type Props = {
  locale: Locale
  change: FaqChange
  onClose: () => void
  /** 打开这条 FAQ（追问 / 选项是父节点）；null = 没有可打开的（版本、已删除的 FAQ）。 */
  onOpenFaq: ((faqId: string) => void) | null
  /**
   * 关掉后焦点还给谁（点击时的「View details」）。打开时页面已经 inert，浏览器会把焦点从那个按钮上拿走，
   * 挂载时再读 document.activeElement 就只剩 <body>（浏览器 E2E 发现）。
   */
  returnFocus?: HTMLElement | null
}

export function ChangeDetailsDrawer({ locale, change, onClose, onOpenFaq, returnFocus = null }: Props) {
  const uid = useId()
  const titleId = `${uid}-title`
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = returnFocus ?? (document.activeElement as HTMLElement | null)
    closeRef.current?.focus()
    return () => opener?.focus?.()
    // 只在打开时记一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useModal(() => drawerRef.current, onClose)

  const d = (key: string, values?: Record<string, string | number>) => t(locale, `helpDesk.changes.details.${key}`, values)
  const learners = learnersLine(locale, change)
  const role = personRole(locale, change)
  const email = change.employee?.email
  const fields = change.changes.length
  const faqGone = change.faq?.status === 'archived' && change.subject !== 'release'
  const target = change.subject !== 'release' && change.faq && !faqGone ? change.faq.id : null

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={onClose} />
      <aside ref={drawerRef} className="hdDrawer hdChangeDrawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={titleId}>
              {d('title')}
            </h2>
            <p className="hdDrawerSubtitle">
              {subjectLabel(locale, change)} · {changeTitle(locale, change)}
            </p>
          </div>
          <button ref={closeRef} type="button" className="hdDrawerClose" aria-label={d('close')} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="hdDrawerBody hdChangeBody">
          <section className="hdChangeCard" aria-labelledby={`${uid}-who`}>
            <h3 className="hdChangeHeading" id={`${uid}-who`}>
              {d('whoWhen')}
            </h3>
            <dl className="hdChangeFacts">
              <div className="hdChangeFact">
                <dt>{d('changedBy')}</dt>
                <dd>
                  <span className="hdChangesStrong">{personName(locale, change)}</span>
                  {role || email ? <span className="hdChangesSub">{[role, email].filter(Boolean).join(' · ')}</span> : null}
                </dd>
              </div>
              <div className="hdChangeFact">
                <dt>{t(locale, 'helpDesk.changes.columns.when')}</dt>
                <dd>
                  <span className="hdChangesStrong">{changeDateTime(change.at, locale)}</span>
                  <span className="hdChangesSub">{d('timeZone', { zone: viewerTimeZone() })}</span>
                </dd>
              </div>
              <div className="hdChangeFact">
                <dt>{t(locale, 'helpDesk.changes.columns.change')}</dt>
                <dd>
                  <span className={`hdChangeChip hdChangeChip-${actionTone(change)}`}>
                    {subjectLabel(locale, change)} · {actionLabel(locale, change)}
                  </span>
                  {change.version ? (
                    <span className="hdChangesSub">
                      {change.version.from === null
                        ? d('newVersion', { to: change.version.to })
                        : d('versionLine', {
                            from: change.version.from,
                            to: change.version.to,
                          })}
                    </span>
                  ) : null}
                </dd>
              </div>
              {learners ? (
                <div className="hdChangeFact">
                  <dt>{t(locale, 'helpDesk.changes.learners.title')}</dt>
                  <dd>
                    <span className={`hdChangeChip hdChangeChip-${learners.state === 'live' ? 'green' : 'orange'}`}>
                      {t(locale, `helpDesk.changes.learners.${learners.state}`)}
                    </span>
                    <span className="hdChangesSub">{learners.hint}</span>
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="hdChangeCard" aria-labelledby={`${uid}-what`}>
            <h3 className="hdChangeHeading" id={`${uid}-what`}>
              {fields === 0 ? d('what') : fields === 1 ? d('whatOne') : d('whatCount', { count: fields })}
            </h3>
            <ChangeDiff locale={locale} change={change} />
            {fields > 0 ? <p className="hdChangeLegend">{d('legend')}</p> : null}
          </section>
          {faqGone ? <p className="hdNotice hdDrawerNotice">{d('faqGone')}</p> : null}
        </div>

        <footer className="hdDrawerFoot">
          <span className="hdDrawerSpacer" />
          <button type="button" className="hdDrawerButton" onClick={onClose}>
            {d('close')}
          </button>
          {target && onOpenFaq ? (
            <button type="button" className="hdDrawerButton hdDrawerPrimary" onClick={() => onOpenFaq(target)}>
              {d('openFaq')}
            </button>
          ) : null}
        </footer>
      </aside>
    </div>
  )
}
