import { useCallback, useEffect, useMemo, useState } from 'react'

import '../students.css'
import { CloseIcon } from '../components/icons'
import { SettingsSubNav } from '../components/SettingsSubNav'
import { FEATURE_KEYS, REASON_MAX, type FeatureKey, type FeatureSetting, type FeatureSettings } from '../contracts/students'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { studentsApi } from '../lib/studentsApi'
import { formatStudentDate, studentErrorText } from '../lib/studentsFormat'
import { isActionAllowed } from '../rbac/permissions'
import { useEmployee } from '../employeeSession';
import { MenuGuard } from './ModulePages'

type Pending = { kind: 'save' } | { kind: 'emergency'; feature: FeatureKey; off: boolean }

/**
 * Settings › Learning Access & Experiments（Figma 1444:378）。
 * 全局默认的开关先在页面上改，点 Save Changes 再弹确认（写明影响人数和原因）；
 * 紧急关闭 / 恢复是 Figma 没有的状态，复用现有样式（待视觉验收，补充稿见设计画布 2.1a）。
 */
export function LearningAccessPage() {
  const employee = useEmployee()
  return (
    <MenuGuard menu="settings">
      <SettingsSubNav role={employee.role} />
      <LearningAccessInner />
    </MenuGuard>
  )
}

function LearningAccessInner() {
  const locale = useLocale()
  const employee = useEmployee()
  const canWrite = isActionAllowed(employee.role, 'settings', 'PUBLISH')
  const [data, setData] = useState<FeatureSettings | null>(null)
  const [draft, setDraft] = useState<Record<FeatureKey, boolean> | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const apply = useCallback((next: FeatureSettings) => {
    setData(next)
    const values = {} as Record<FeatureKey, boolean>
    for (const row of next.features) values[row.feature] = row.globalEnabled
    setDraft(values)
  }, [])

  const load = useCallback(() => {
    return studentsApi.settings().then((result) => {
      if (result.ok) {
        apply(result.data)
        setErrorCode(null)
      } else {
        setErrorCode(result.code)
      }
    })
  }, [apply])

  useEffect(() => {
    void load()
  }, [load])

  const changed = useMemo(
    () => (data && draft ? data.features.filter((row) => draft[row.feature] !== row.globalEnabled) : []),
    [data, draft],
  )

  const rows = data ? FEATURE_KEYS.map((key) => data.features.find((row) => row.feature === key)).filter(Boolean) as FeatureSetting[] : []

  return (
    <section className="card cardGrow smSettings" data-testid="learning-access-page">
      <div className="pageHead" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="cardTitle">{t(locale, 'learningAccess.title')}</h1>
          <p className="cardSubtitle">{t(locale, 'learningAccess.subtitle')}</p>
        </div>
        {canWrite ? (
          <div className="smHeadActions">
            {changed.length ? <span className="smPill smPillWarn">{t(locale, 'learningAccess.unsaved')}</span> : null}
            {changed.length ? (
              <button type="button" className="button buttonGhost buttonCompact" onClick={() => data && apply(data)}>
                {t(locale, 'learningAccess.discard')}
              </button>
            ) : null}
            <button
              type="button"
              className="button buttonCompact"
              disabled={!changed.length}
              onClick={() => setPending({ kind: 'save' })}
              data-testid="settings-save"
            >
              {t(locale, 'learningAccess.save')}
            </button>
          </div>
        ) : null}
      </div>

      {errorCode ? (
        <div className="alert alertError" role="alert">
          {errorCode === 'STUDENTS_NOT_CONNECTED' ? t(locale, 'students.notConnected') : t(locale, 'learningAccess.loadError')}{' '}
          <button type="button" className="linkButton" onClick={() => void load()}>{t(locale, 'learningAccess.retry')}</button>
        </div>
      ) : null}
      {notice ? <div className="alert alertOk" role="status">{notice}</div> : null}
      {!canWrite ? <div className="smBanner smBannerInfo">{t(locale, 'learningAccess.readOnly')}</div> : null}

      {rows
        .filter((row) => row.emergencyOff)
        .map((row) => (
          <div className="smBanner smBannerDanger" key={`em-${row.feature}`} data-testid={`emergency-banner-${row.feature}`}>
            <strong>{t(locale, 'learningAccess.emergencyBanner', { feature: t(locale, `students.feature.${row.feature}`) })}</strong>
            {t(locale, 'learningAccess.emergencyBody', {
              name: row.emergencyOff!.byName,
              date: formatStudentDate(row.emergencyOff!.at, locale),
              reason: row.emergencyOff!.reason,
            })}
          </div>
        ))}

      <section className="smSection">
        <h2 className="smSectionTitle">{t(locale, 'learningAccess.featureAccess')}</h2>
        <p className="smSectionHint">{t(locale, 'learningAccess.featureAccessHint')}</p>
        {!data && !errorCode ? <p className="smMuted">{t(locale, 'common.loading')}</p> : null}
        {data && draft ? (
          <table className="smSettingsTable">
            <thead>
              <tr>
                <th>{t(locale, 'learningAccess.feature')}</th>
                <th>{t(locale, 'learningAccess.globalDefault')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = t(locale, `students.feature.${row.feature}`)
                const on = draft[row.feature]
                return (
                  <tr key={row.feature} data-testid={`feature-row-${row.feature}`}>
                    <td>
                      <div className="smFeatureName">{name}</div>
                      <div className="smFeatureHint">{t(locale, `students.featureHint.${row.feature}`)}</div>
                      <div className="smSettingsMeta">
                        <span>{t(locale, 'learningAccess.overrides', { allow: row.overrides.allow, deny: row.overrides.deny })}</span>
                        {row.updated ? (
                          <span>{t(locale, 'learningAccess.updated', { name: row.updated.byName, date: formatStudentDate(row.updated.at, locale) })}</span>
                        ) : null}
                        {row.emergencyOff ? <span className="smPill smPillInactive">{t(locale, 'learningAccess.emergencyStatus')}</span> : null}
                        {canWrite ? (
                          <button
                            type="button"
                            className="linkButton"
                            style={row.emergencyOff ? undefined : { color: '#b91c1c' }}
                            onClick={() => setPending({ kind: 'emergency', feature: row.feature, off: !row.emergencyOff })}
                          >
                            {t(locale, row.emergencyOff ? 'learningAccess.resume' : 'learningAccess.emergencyOff')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <span className="smToggleCell">
                        <span className="smToggleText">{t(locale, on ? 'learningAccess.on' : 'learningAccess.off')}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={name}
                          className={on ? 'smSwitch smSwitchOn' : 'smSwitch'}
                          disabled={!canWrite}
                          onClick={() => setDraft({ ...draft, [row.feature]: !on })}
                        />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
        <p className="smFootnote">{t(locale, 'learningAccess.footnote')}</p>
      </section>

      <section className="smSection">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 className="smSectionTitle" style={{ margin: 0 }}>{t(locale, 'learningAccess.experiments')}</h2>
          <span className="smPill smPillBlue">{t(locale, 'learningAccess.comingSoon')}</span>
        </div>
        <p className="smSectionHint" style={{ marginTop: 8 }}>{t(locale, 'learningAccess.experimentsBody')}</p>
        <div className="smTags">
          {(['tutor', 'banner', 'pricing'] as const).map((tag) => (
            <span className="smPill smPillMuted" key={tag}>{t(locale, `learningAccess.experimentTags.${tag}`)}</span>
          ))}
        </div>
      </section>

      {pending && data && draft ? (
        <SettingsConfirm
          pending={pending}
          data={data}
          draft={draft}
          changed={changed}
          onCancel={() => setPending(null)}
          onDone={(next) => {
            apply(next)
            setPending(null)
            setNotice(t(locale, 'learningAccess.saved'))
          }}
          onConflict={() => void load()}
        />
      ) : null}
    </section>
  )
}

function SettingsConfirm({
  pending,
  data,
  draft,
  changed,
  onCancel,
  onDone,
  onConflict,
}: {
  pending: Pending
  data: FeatureSettings
  draft: Record<FeatureKey, boolean>
  changed: FeatureSetting[]
  onCancel: () => void
  onDone: (next: FeatureSettings) => void
  onConflict: () => void
}) {
  const locale = useLocale()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emergency = pending.kind === 'emergency' ? pending : null
  const featureName = emergency ? t(locale, `students.feature.${emergency.feature}`) : ''

  const title = emergency
    ? t(locale, emergency.off ? 'learningAccess.emergencyTitle' : 'learningAccess.resumeTitle', { feature: featureName })
    : changed.length === 1
      ? t(locale, draft[changed[0]!.feature] ? 'learningAccess.confirmOnTitle' : 'learningAccess.confirmOffTitle', {
          feature: t(locale, `students.feature.${changed[0]!.feature}`),
        })
      : t(locale, 'learningAccess.save')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !reason.trim()) return
    setBusy(true)
    const result = emergency
      ? await studentsApi.emergency({ feature: emergency.feature, off: emergency.off, reason: reason.trim() })
      : await studentsApi.saveSettings({
          reason: reason.trim(),
          expectedVersion: data.version,
          features: Object.fromEntries(changed.map((row) => [row.feature, { enabled: draft[row.feature] }])),
        })
    setBusy(false)
    if (result.ok) onDone(result.data)
    else {
      setError(studentErrorText(locale, result.code))
      if (result.code === 'VERSION_CONFLICT') onConflict()
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal smModal" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit} noValidate>
        <div className="modalHead">
          <h2 className="modalTitle">{title}</h2>
          <button type="button" className="modalClose" aria-label={t(locale, 'studentDrawer.close')} onClick={onCancel}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modalBody">
          {error ? <div className="alert alertError" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
          {emergency ? (
            <p className="cardBody">{t(locale, emergency.off ? 'learningAccess.emergencyConfirmBody' : 'learningAccess.resumeBody')}</p>
          ) : (
            changed.map((row) => {
              const name = t(locale, `students.feature.${row.feature}`)
              const turningOn = draft[row.feature]
              return (
                <div key={row.feature}>
                  {changed.length > 1 ? (
                    <p className="fieldLabel">
                      {t(locale, turningOn ? 'learningAccess.confirmOnTitle' : 'learningAccess.confirmOffTitle', { feature: name })}
                    </p>
                  ) : null}
                  <p className="cardBody">
                    {turningOn
                      ? `${t(locale, 'learningAccess.confirmOnBody', { count: row.eligibleDefault })} ${t(locale, 'learningAccess.confirmOnDeny', { deny: row.overrides.deny, allow: row.overrides.allow })}`
                      : t(locale, 'learningAccess.confirmOffBody', { allow: row.overrides.allow })}
                  </p>
                </div>
              )
            })
          )}
          <label className="field">
            <span className="fieldLabel">{t(locale, 'learningAccess.reason')}</span>
            <textarea
              className="fieldInput smTextarea"
              maxLength={REASON_MAX}
              placeholder={t(locale, 'learningAccess.reasonPlaceholder')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
        <div className="modalFooter">
          <button type="button" className="button buttonGhost" onClick={onCancel}>{t(locale, 'learningAccess.cancel')}</button>
          <button
            type="submit"
            className={emergency?.off ? 'button buttonDanger' : 'button'}
            disabled={busy || !reason.trim()}
            data-testid="settings-confirm"
          >
            {emergency
              ? t(locale, emergency.off ? 'learningAccess.emergencyConfirm' : 'learningAccess.resumeConfirm')
              : t(locale, 'learningAccess.confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}
