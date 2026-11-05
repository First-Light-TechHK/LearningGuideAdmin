import { useCallback, useEffect, useMemo, useState } from 'react'

import { CloseIcon } from './icons'
import {
  FEATURE_KEYS,
  REASON_MAX,
  REFERENCE_MAX,
  type FeatureKey,
  type OverrideValue,
  type StudentDetails,
  type StudentSubscription,
} from '../contracts/students'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { studentsApi } from '../lib/studentsApi'
import { EMAIL_PATTERN, formatStudentDate, initialOf, studentErrorText } from '../lib/studentsFormat'

type ModalKind = 'deactivate' | 'activate' | 'email' | 'password' | 'resend' | 'discard'
type Notice = { tone: 'ok' | 'error'; text: string }

const OVERRIDES: OverrideValue[] = ['default', 'allow', 'deny']

function draftFrom(detail: StudentDetails): Record<FeatureKey, OverrideValue> {
  const draft = { improve_tutor: 'default', ai_support_assistant: 'default' } as Record<FeatureKey, OverrideValue>
  for (const row of detail.features) draft[row.feature] = row.override
  return draft
}

function subscriptionDate(locale: Locale, sub: StudentSubscription): string {
  if (sub.state === 'grace') return t(locale, 'studentDrawer.graceUntil', { date: formatStudentDate(sub.graceEndsAt, locale) })
  if (sub.state === 'expired' || sub.state === 'trial_canceled') return t(locale, 'studentDrawer.endedOn', { date: formatStudentDate(sub.validTo, locale) })
  if (sub.state === 'active' && sub.renews) return t(locale, 'studentDrawer.renews', { date: formatStudentDate(sub.validTo, locale) })
  return t(locale, 'studentDrawer.endsOn', { date: formatStudentDate(sub.validTo, locale) })
}

function subPillClass(sub: StudentSubscription): string {
  if (sub.state === 'active') return 'smPill smPillActive'
  if (sub.state === 'grace' || sub.state === 'cancel_at_period_end') return 'smPill smPillWarn'
  return 'smPill smPillMuted'
}

/**
 * 学生详情抽屉（Figma 1438:123）。Figma 没画的状态：停用横幅、只读提示、未保存提示、
 * 修改原因、弹窗等复用现有样式（待视觉验收，补充稿见设计画布 1.2a–1.2c）。
 */
export function StudentDrawer({
  studentId,
  canWrite,
  onClose,
  onChanged,
}: {
  studentId: string
  canWrite: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const locale = useLocale()
  const [detail, setDetail] = useState<StudentDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<FeatureKey, OverrideValue> | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [modal, setModal] = useState<ModalKind | null>(null)
  const [showEnded, setShowEnded] = useState(false)
  const [copied, setCopied] = useState(false)

  const apply = useCallback((next: StudentDetails) => {
    setDetail(next)
    setDraft(draftFrom(next))
    setReason('')
  }, [])

  const fetchLoad = useCallback(() => {
    return studentsApi.detail(studentId).then((result) => {
      if (result.ok) apply(result.data)
      else setLoadError(result.code)
    })
  }, [studentId, apply])

  const [loadSource, setLoadSource] = useState(() => ({ studentId }))
  if (loadSource.studentId !== studentId) {
    setLoadSource({ studentId })
    setLoadError(null)
  }
  const load = useCallback(() => {
    setLoadError(null)
    return fetchLoad()
  }, [fetchLoad])

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  const dirty = useMemo(() => {
    if (!detail || !draft) return false
    const saved = draftFrom(detail)
    return FEATURE_KEYS.some((key) => saved[key] !== draft[key])
  }, [detail, draft])

  const requestClose = useCallback(() => {
    if (dirty) setModal('discard')
    else onClose()
  }, [dirty, onClose])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (modal) setModal(null)
      else requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, requestClose])

  async function saveOverrides() {
    if (!detail || !draft || !dirty || !reason.trim()) return
    const saved = draftFrom(detail)
    const overrides: Partial<Record<FeatureKey, OverrideValue>> = {}
    for (const key of FEATURE_KEYS) if (saved[key] !== draft[key]) overrides[key] = draft[key]
    setSaving(true)
    const result = await studentsApi.saveOverrides(detail.id, {
      reason: reason.trim(),
      expectedVersion: detail.overridesVersion,
      overrides,
    })
    setSaving(false)
    if (result.ok) {
      apply(result.data)
      setNotice({ tone: 'ok', text: t(locale, 'studentDrawer.saved') })
      onChanged()
    } else {
      setNotice({ tone: 'error', text: studentErrorText(locale, result.code) })
    }
  }

  async function copyId() {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时不提示，ID 本身可选中复制
    }
  }

  const inactive = detail?.accountStatus === 'inactive'
  const current = detail?.subscriptions.filter((sub) => sub.current) ?? []
  const ended = detail?.subscriptions.filter((sub) => !sub.current) ?? []

  return (
    <div className="smDrawerBackdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <aside className="smDrawer" role="dialog" aria-modal="true" aria-labelledby="sm-drawer-title" data-testid="student-drawer">
        <header className="smDrawerHead">
          <div>
            <h2 className="smDrawerTitle" id="sm-drawer-title">{t(locale, 'studentDrawer.title')}</h2>
            {detail ? (
              <div className="smDrawerMeta">
                <span>{detail.email ?? t(locale, 'students.noEmail')}</span>
                <span>·</span>
                <span>{t(locale, 'studentDrawer.studentId', { id: detail.id })}</span>
                <button type="button" className="linkButton" onClick={() => void copyId()}>
                  {t(locale, copied ? 'studentDrawer.copied' : 'studentDrawer.copyId')}
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" className="modalClose" aria-label={t(locale, 'studentDrawer.close')} onClick={requestClose}>
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="smDrawerBody">
          {loadError ? (
            <div className="alert alertError" role="alert">
              {loadError === 'STUDENT_NOT_FOUND' ? t(locale, 'studentDrawer.notFound') : studentErrorText(locale, loadError)}{' '}
              {loadError !== 'STUDENT_NOT_FOUND' ? (
                <button type="button" className="linkButton" onClick={() => void load()}>{t(locale, 'students.retry')}</button>
              ) : null}
            </div>
          ) : null}
          {!detail && !loadError ? <p className="smMuted">{t(locale, 'common.loading')}</p> : null}

          {detail && draft ? (
            <>
              {notice ? (
                <div className={notice.tone === 'ok' ? 'alert alertOk' : 'alert alertError'} role="status" data-testid="student-notice">
                  {notice.text}
                </div>
              ) : null}
              {inactive && detail.deactivation ? (
                <div className="smBanner smBannerDanger" data-testid="student-inactive-banner">
                  <strong>{t(locale, 'studentDrawer.inactiveBanner')}</strong>
                  {t(locale, 'studentDrawer.inactiveBody', {
                    name: detail.deactivation.byName,
                    date: formatStudentDate(detail.deactivation.at, locale),
                    reason: detail.deactivation.reason,
                  })}
                </div>
              ) : null}
              {!canWrite ? <div className="smBanner smBannerInfo">{t(locale, 'studentDrawer.readOnly')}</div> : null}

              <div className="smIdentity">
                <span className="smAvatar smAvatarLg" aria-hidden="true">{initialOf(detail.name)}</span>
                <div>
                  <div className="smName">{detail.name}</div>
                  <span className="smSub">
                    {t(locale, 'studentDrawer.registered', { date: formatStudentDate(detail.registeredAt, locale) })} ·{' '}
                    {t(locale, `studentDrawer.emailState.${detail.emailVerification}`)}
                  </span>
                  {detail.emailExemption ? (
                    <span className="smSub">
                      {t(locale, 'studentDrawer.exemptBy', {
                        name: detail.emailExemption.byName,
                        date: formatStudentDate(detail.emailExemption.at, locale),
                        reference: detail.emailExemption.reference,
                      })}
                    </span>
                  ) : detail.emailChange ? (
                    <span className="smSub">
                      {t(locale, 'studentDrawer.emailChanged', {
                        name: detail.emailChange.byName,
                        date: formatStudentDate(detail.emailChange.at, locale),
                        reference: detail.emailChange.reference,
                      })}
                    </span>
                  ) : null}
                </div>
                <span className={inactive ? 'smPill smPillInactive' : 'smPill smPillActive'}>
                  {t(locale, `students.accountStatus.${detail.accountStatus}`)}
                </span>
              </div>

              <section className="smSection">
                <h3 className="smSectionTitle">{t(locale, 'studentDrawer.profile')}</h3>
                <dl className="smGrid">
                  <div><dt>{t(locale, 'studentDrawer.country')}</dt><dd>{detail.profile.country ?? t(locale, 'studentDrawer.notProvided')}</dd></div>
                  <div><dt>{t(locale, 'studentDrawer.ageRange')}</dt><dd>{detail.profile.ageRange ?? t(locale, 'studentDrawer.notProvided')}</dd></div>
                  <div><dt>{t(locale, 'studentDrawer.education')}</dt><dd>{detail.profile.education ?? t(locale, 'studentDrawer.notProvided')}</dd></div>
                  <div>
                    <dt>{t(locale, 'studentDrawer.interests')}</dt>
                    <dd>{detail.profile.interests.length ? detail.profile.interests.join(', ') : t(locale, 'studentDrawer.notProvided')}</dd>
                  </div>
                  <div><dt>{t(locale, 'studentDrawer.language')}</dt><dd>{t(locale, `studentDrawer.languageName.${detail.profile.language}`)}</dd></div>
                  <div>
                    <dt>{t(locale, 'studentDrawer.signIn')}</dt>
                    <dd>
                      {detail.signInMethods.map((method) => t(locale, `studentDrawer.signInMethod.${method}`)).join(', ') || t(locale, 'studentDrawer.notProvided')}
                      {!detail.hasPassword ? ` (${t(locale, 'studentDrawer.noPassword')})` : ''}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="smSection" data-testid="student-subscriptions">
                <h3 className="smSectionTitle">
                  {current.length > 1 ? t(locale, 'studentDrawer.subscriptionCount', { count: current.length }) : t(locale, 'studentDrawer.subscription')}
                </h3>
                {current.length === 0 ? <p className="smSectionHint">{t(locale, 'studentDrawer.noSubscription')}</p> : null}
                {[...current, ...(showEnded ? ended : [])].map((sub) => (
                  <div className="smSub2" key={sub.id}>
                    <div>
                      <div className="smSub2Main">
                        {sub.label} · {t(locale, 'studentDrawer.coursesOnly')}
                        {sub.aiTutor ? ` + ${t(locale, 'studentDrawer.aiTutor')}` : ''}
                      </div>
                      <span className="smSub">
                        {t(locale, `studentDrawer.device.${sub.device}`)}
                        {sub.source === 'trial' ? ` · ${t(locale, 'studentDrawer.trial')}` : ''}
                        {sub.orderId ? ` · ${t(locale, 'studentDrawer.orderId', { id: sub.orderId })}` : ''}
                      </span>
                    </div>
                    <div className="smSub2Side">
                      <span className={subPillClass(sub)}>{t(locale, `students.subState.${sub.state}`)}</span>
                      <span>{subscriptionDate(locale, sub)}</span>
                    </div>
                  </div>
                ))}
                {ended.length ? (
                  <button type="button" className="linkButton" onClick={() => setShowEnded((v) => !v)}>
                    {showEnded ? t(locale, 'studentDrawer.hideEnded') : t(locale, 'studentDrawer.showEnded', { count: ended.length })}
                  </button>
                ) : null}
              </section>

              <section className="smSection" data-testid="student-access">
                <h3 className="smSectionTitle">{t(locale, 'studentDrawer.access')}</h3>
                <p className="smSectionHint">{t(locale, inactive ? 'studentDrawer.overridesKept' : 'studentDrawer.accessHint')}</p>
                {detail.features.map((row) => {
                  const name = t(locale, `students.feature.${row.feature}`)
                  return (
                    <div className="smFeature" key={row.feature}>
                      <div>
                        <div className="smFeatureName">{name}</div>
                        <div className="smFeatureHint">{t(locale, `students.featureHint.${row.feature}`)}</div>
                      </div>
                      <select
                        className="fieldSelect"
                        aria-label={t(locale, 'studentDrawer.overrideLabel', { feature: name })}
                        value={draft[row.feature]}
                        disabled={!canWrite || inactive || saving}
                        onChange={(event) => setDraft({ ...draft, [row.feature]: event.target.value as OverrideValue })}
                      >
                        {OVERRIDES.map((value) => (
                          <option key={value} value={value}>{t(locale, `studentDrawer.override.${value}`)}</option>
                        ))}
                      </select>
                      <span className={row.enabled ? 'smPill smPillActive' : 'smPill smPillMuted'} data-testid={`effective-${row.feature}`}>
                        {t(locale, row.enabled ? 'studentDrawer.effective.on' : 'studentDrawer.effective.off')}
                      </span>
                      <div className="smFeatureWhy">{t(locale, `studentDrawer.reason.${row.reason}`)}</div>
                    </div>
                  )
                })}
                {dirty ? (
                  <label className="field" style={{ marginTop: 10 }}>
                    <span className="fieldLabel">{t(locale, 'studentDrawer.changeReason')}</span>
                    <textarea
                      className="fieldInput smTextarea"
                      maxLength={REASON_MAX}
                      placeholder={t(locale, 'studentDrawer.changeReasonPlaceholder')}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                ) : null}
              </section>

              <div className="smComing">
                <span>{t(locale, 'studentDrawer.experiment')}</span>
                <span className="smPill smPillMuted">{t(locale, 'studentDrawer.comingSoon')}</span>
              </div>

              {canWrite ? (
                <section className="smSection" data-testid="student-actions">
                  <h3 className="smSectionTitle">{t(locale, 'studentDrawer.actions')}</h3>
                  <p className="smSectionHint">{t(locale, 'studentDrawer.actionsHint')}</p>
                  <div className="smActions">
                    <button
                      type="button"
                      className="button buttonGhost buttonCompact"
                      disabled={!detail.passwordLink.available}
                      title={detail.passwordLink.available ? undefined : t(locale, `studentDrawer.passwordBlocked.${detail.passwordLink.blockedBy}`)}
                      onClick={() => setModal('password')}
                    >
                      {t(locale, detail.passwordLink.available && detail.passwordLink.kind === 'setup' ? 'studentDrawer.sendSetup' : 'studentDrawer.sendReset')}
                    </button>
                    {detail.email && detail.emailVerification === 'pending' && !inactive ? (
                      <button type="button" className="button buttonGhost buttonCompact" onClick={() => setModal('resend')}>
                        {t(locale, 'studentDrawer.resendVerification')}
                      </button>
                    ) : null}
                    {!inactive ? (
                      <button type="button" className="button buttonGhost buttonCompact" onClick={() => setModal('email')}>
                        {t(locale, 'studentDrawer.editEmail')}
                      </button>
                    ) : null}
                    {inactive ? (
                      <button type="button" className="button buttonCompact" onClick={() => setModal('activate')}>
                        {t(locale, 'studentDrawer.activate')}
                      </button>
                    ) : (
                      <button type="button" className="button buttonCompact buttonDangerGhost" onClick={() => setModal('deactivate')}>
                        {t(locale, 'studentDrawer.deactivate')}
                      </button>
                    )}
                  </div>
                  {!detail.passwordLink.available ? (
                    <p className="smSectionHint" style={{ marginTop: 8 }}>
                      {t(locale, `studentDrawer.passwordBlocked.${detail.passwordLink.blockedBy}`)}
                    </p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="smDrawerFoot">
          {dirty ? <span className="smUnsaved">{t(locale, 'studentDrawer.unsaved')}</span> : null}
          <button type="button" className="button buttonGhost" onClick={requestClose}>
            {t(locale, 'studentDrawer.cancel')}
          </button>
          {canWrite ? (
            <button
              type="button"
              className="button"
              disabled={!dirty || !reason.trim() || saving}
              onClick={() => void saveOverrides()}
              data-testid="student-save"
            >
              {t(locale, saving ? 'studentDrawer.saving' : 'studentDrawer.save')}
            </button>
          ) : null}
        </footer>
      </aside>

      {modal === 'discard' ? (
        <ConfirmModal
          title={t(locale, 'studentDrawer.discardTitle')}
          confirmLabel={t(locale, 'studentDrawer.discard')}
          cancelLabel={t(locale, 'studentDrawer.keepEditing')}
          danger
          onCancel={() => setModal(null)}
          onConfirm={async () => {
            onClose()
            return null
          }}
        >
          <p className="cardBody">{t(locale, 'studentDrawer.discardBody')}</p>
        </ConfirmModal>
      ) : null}

      {modal && modal !== 'discard' && detail ? (
        <ActionModal
          kind={modal}
          detail={detail}
          onCancel={() => setModal(null)}
          onDone={(next, text) => {
            apply(next)
            setModal(null)
            setNotice({ tone: 'ok', text })
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

/** 通用确认弹窗：onConfirm 返回错误文案（或 null 表示成功）。 */
function ConfirmModal({
  title,
  confirmLabel,
  cancelLabel,
  danger,
  disabled,
  onCancel,
  onConfirm,
  children,
}: {
  title: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  disabled?: boolean
  onCancel: () => void
  onConfirm: () => Promise<string | null>
  children: React.ReactNode
}) {
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="modalBackdrop" style={{ zIndex: 120 }}>
      <form
        className="modal smModal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        noValidate
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy || disabled) return
          setBusy(true)
          const message = await onConfirm()
          setBusy(false)
          setError(message)
        }}
      >
        <div className="modalHead">
          <h2 className="modalTitle">{title}</h2>
          <button type="button" className="modalClose" aria-label={t(locale, 'studentDrawer.close')} onClick={onCancel}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modalBody">
          {error ? <div className="alert alertError" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
          {children}
        </div>
        <div className="modalFooter">
          <button type="button" className="button buttonGhost" onClick={onCancel}>
            {cancelLabel ?? t(locale, 'studentModal.cancel')}
          </button>
          <button type="submit" className={danger ? 'button buttonDanger' : 'button'} disabled={busy || disabled} data-testid="modal-confirm">
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

function ActionModal({
  kind,
  detail,
  onCancel,
  onDone,
}: {
  kind: Exclude<ModalKind, 'discard'>
  detail: StudentDetails
  onCancel: () => void
  onDone: (next: StudentDetails, notice: string) => void
}) {
  const locale = useLocale()
  const [reason, setReason] = useState('')
  const [email, setEmail] = useState('')
  const [exempt, setExempt] = useState(false)
  const [reference, setReference] = useState('')

  const emailValid = EMAIL_PATTERN.test(email.trim())
  const reasonField = (label: string) => (
    <label className="field">
      <span className="fieldLabel">{label}</span>
      <textarea
        className="fieldInput smTextarea"
        maxLength={REASON_MAX}
        placeholder={t(locale, 'studentModal.reasonPlaceholder')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </label>
  )

  async function run(body: Record<string, unknown>, notice: (sent: boolean | null) => string): Promise<string | null> {
    const result = await studentsApi.act(detail.id, body)
    if (!result.ok) return studentErrorText(locale, result.code)
    onDone(result.data.student, notice(result.data.email ? result.data.email.sent : null))
    return null
  }

  if (kind === 'deactivate' || kind === 'activate') {
    const deactivate = kind === 'deactivate'
    return (
      <ConfirmModal
        title={t(locale, deactivate ? 'studentModal.deactivateTitle' : 'studentModal.activateTitle', { name: detail.name })}
        confirmLabel={t(locale, deactivate ? 'studentModal.deactivateConfirm' : 'studentModal.activateConfirm')}
        danger={deactivate}
        disabled={!reason.trim()}
        onCancel={onCancel}
        onConfirm={() => run({ action: kind, reason: reason.trim() }, () => t(locale, `studentNotice.${kind}`))}
      >
        <p className="cardBody">{t(locale, deactivate ? 'studentModal.deactivateBody' : 'studentModal.activateBody')}</p>
        {deactivate ? <div className="smBanner smBannerInfo">{t(locale, 'studentModal.deactivateBilling')}</div> : null}
        {reasonField(t(locale, 'studentModal.reason'))}
      </ConfirmModal>
    )
  }

  if (kind === 'email') {
    const ready = emailValid && reason.trim() !== '' && (!exempt || reference.trim() !== '')
    return (
      <ConfirmModal
        title={t(locale, 'studentModal.emailTitle')}
        confirmLabel={t(locale, exempt ? 'studentModal.emailSave' : 'studentModal.emailSend')}
        disabled={!ready}
        onCancel={onCancel}
        onConfirm={() =>
          run(
            {
              action: 'change_email',
              email: email.trim(),
              reason: reason.trim(),
              exemption: exempt ? { reference: reference.trim() } : null,
            },
            (sent) =>
              exempt
                ? t(locale, 'studentNotice.change_email_exempt')
                : sent === false
                  ? t(locale, 'studentNotice.change_email_unsent')
                  : t(locale, 'studentNotice.change_email'),
          )
        }
      >
        <p className="smSectionHint" style={{ margin: 0 }}>
          {t(locale, 'studentModal.emailCurrent', { email: detail.email ?? t(locale, 'students.noEmail') })}
        </p>
        <label className="field">
          <span className="fieldLabel">{t(locale, 'studentModal.emailNew')}</span>
          <input
            className="fieldInput"
            type="email"
            autoComplete="off"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={email !== '' && !emailValid}
          />
          {email !== '' && !emailValid ? <span className="fieldHint">{t(locale, 'studentModal.invalidEmail')}</span> : null}
        </label>
        {reasonField(t(locale, 'studentModal.emailReason'))}
        <label className="smCheck">
          <input type="checkbox" checked={exempt} onChange={(event) => setExempt(event.target.checked)} />
          <span>{t(locale, 'studentModal.emailExempt')}</span>
        </label>
        {exempt ? (
          <>
            <label className="field">
              <span className="fieldLabel">{t(locale, 'studentModal.emailExemptRef')}</span>
              <input
                className="fieldInput"
                maxLength={REFERENCE_MAX}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
            <div className="smBanner smBannerDanger">{t(locale, 'studentModal.emailExemptWarn')}</div>
          </>
        ) : (
          <p className="cardBody">{t(locale, 'studentModal.emailStandard')}</p>
        )}
      </ConfirmModal>
    )
  }

  if (kind === 'password') {
    const setup = detail.passwordLink.available && detail.passwordLink.kind === 'setup'
    return (
      <ConfirmModal
        title={t(locale, setup ? 'studentModal.passwordSetupTitle' : 'studentModal.passwordResetTitle')}
        confirmLabel={t(locale, 'studentModal.passwordSend')}
        onCancel={onCancel}
        onConfirm={() => run({ action: 'send_password_link' }, () => t(locale, 'studentNotice.send_password_link'))}
      >
        <p className="fieldLabel">{t(locale, 'studentModal.passwordTo', { email: detail.email ?? '' })}</p>
        <p className="cardBody">{t(locale, setup ? 'studentModal.passwordSetupBody' : 'studentModal.passwordResetBody')}</p>
      </ConfirmModal>
    )
  }

  return (
    <ConfirmModal
      title={t(locale, 'studentModal.resendTitle')}
      confirmLabel={t(locale, 'studentModal.resendSend')}
      onCancel={onCancel}
      onConfirm={() => run({ action: 'resend_verification' }, () => t(locale, 'studentNotice.resend_verification'))}
    >
      <p className="cardBody">{t(locale, 'studentModal.resendBody', { email: detail.email ?? '' })}</p>
    </ConfirmModal>
  )
}
