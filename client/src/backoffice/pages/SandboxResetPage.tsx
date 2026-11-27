import { useCallback, useEffect, useMemo, useState } from 'react'

import { SettingsSubNav } from '../components/SettingsSubNav'
import { boRequest, postJson } from '../lib/api'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { useEmployee } from '../employeeSession'
import { MenuGuard } from './ModulePages'

type Impact = {
  courses: number
  versions: number
  mediaAssets: number
  mediaBytes: number
  packageJobs: number
}

type ResetState = {
  enabled: boolean
  environment: string
  activeJob: JobView | null
  impact: Impact
}

type JobView = {
  jobId: string
  status: string
  stage: string | null
  progress: number
  error: string | null
  report?: unknown
  counts?: unknown
}

const CONFIRM_PHRASE = 'RESET SANDBOX'
const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING'])

function formatBytes(bytes: number): string {
  const MB = 1024 * 1024
  const KB = 1024
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(1))} MB`
  if (bytes >= KB) return `${Number((bytes / KB).toFixed(1))} KB`
  return `${bytes} B`
}

/**
 * Settings › Sandbox Reset（Sandbox 专项，仅 Sandbox + 开关打开时出现）。
 * 二次确认：先填写确认短语与原因，再在确认面板里点「Confirm reset」。
 * 服务端仍有三层守卫；本页只是入口，非 Sandbox / 非 ADMIN 会被接口拒绝。
 */
export function SandboxResetPage() {
  const employee = useEmployee()
  return (
    <MenuGuard menu="settings">
      <SettingsSubNav role={employee.role} />
      <SandboxResetInner />
    </MenuGuard>
  )
}

function SandboxResetInner() {
  const locale = useLocale()
  const [page, setPage] = useState<ResetState | null>(null)
  const [job, setJob] = useState<JobView | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState({
    courses: true,
    media: true,
    staging: true,
    packageJobs: true,
    resetCodeCounters: true,
  })
  const [showConfirm, setShowConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    return boRequest<ResetState>('/api/backoffice/sandbox/reset').then((result) => {
      if (result.success) {
        setPage(result.data)
        // 环境端点只返回当前活动作业；刚创建的 QUEUED 作业要保留在页面上。
        setJob((current) => result.data.activeJob ?? current)
        setErrorCode(null)
      } else {
        setErrorCode(result.code ?? result.error)
      }
    })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const active = job !== null && ACTIVE_STATUSES.has(job.status)

  const loadJob = useCallback((jobId: string) => {
    return boRequest<JobView>(`/api/backoffice/sandbox/reset/${jobId}`).then((result) => {
      if (result.success) setJob(result.data)
    })
  }, [])

  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return
    const timer = setInterval(() => void loadJob(job.jobId), 2000)
    return () => clearInterval(timer)
  }, [job, loadJob])

  const scopeEmpty = useMemo(() => !Object.values(scope).some(Boolean), [scope])
  const canContinue =
    confirmText.trim() === CONFIRM_PHRASE && reason.trim() !== '' && !scopeEmpty

  async function startReset() {
    setBusy(true)
    setNotice(null)
    const result = await postJson<JobView>('/api/backoffice/sandbox/reset', {
      confirm: confirmText.trim(),
      reason: reason.trim(),
      scope,
    })
    setBusy(false)
    if (result.success) {
      setJob(result.data)
      setShowConfirm(false)
      setConfirmText('')
      setReason('')
      setNotice(t(locale, 'settings.sandboxResetStarted'))
      void load()
    } else {
      setShowConfirm(false)
      setErrorCode(result.code ?? result.error)
    }
  }

  async function cancelJob(jobId: string) {
    setBusy(true)
    const result = await postJson<JobView>(`/api/backoffice/sandbox/reset/${jobId}/cancel`, {})
    setBusy(false)
    if (result.success) setJob(result.data)
  }

  if (errorCode !== null) {
    return (
      <section className="card cardGrow" data-testid="sandbox-reset-unavailable">
        <h1 className="cardTitle">{t(locale, 'settings.sandboxResetTitle')}</h1>
        <p className="cardBody">{t(locale, 'settings.sandboxResetUnavailable')}</p>
      </section>
    )
  }

  if (page === null) {
    return (
      <section className="card cardGrow" data-testid="sandbox-reset-page">
        <p className="cardBody">{t(locale, 'common.loading')}</p>
      </section>
    )
  }

  return (
    <section className="card cardGrow" data-testid="sandbox-reset-page">
      <h1 className="cardTitle">{t(locale, 'settings.sandboxResetTitle')}</h1>
      <p className="cardSubtitle">{t(locale, 'settings.sandboxResetSubtitle')}</p>

      <p style={{ color: '#b91c1c', fontWeight: 600 }} data-testid="sandbox-reset-warning">
        {t(locale, 'settings.sandboxResetWarning')}
      </p>
      <p className="cardBody">
        {t(locale, 'settings.sandboxResetEnvironment', { environment: page.environment })}
      </p>

      <h2 className="cardTitle" style={{ fontSize: 16, marginTop: 16 }}>
        {t(locale, 'settings.sandboxResetImpactTitle')}
      </h2>
      <ul className="cardBody" data-testid="sandbox-reset-impact">
        <li>{t(locale, 'settings.sandboxResetImpactCourses', { count: page.impact.courses })}</li>
        <li>{t(locale, 'settings.sandboxResetImpactVersions', { count: page.impact.versions })}</li>
        <li>
          {t(locale, 'settings.sandboxResetImpactMedia', {
            count: page.impact.mediaAssets,
            size: formatBytes(page.impact.mediaBytes),
          })}
        </li>
        <li>{t(locale, 'settings.sandboxResetImpactJobs', { count: page.impact.packageJobs })}</li>
      </ul>
      <p className="cardBody">{t(locale, 'settings.sandboxResetKeeps')}</p>

      {job ? (
        <section className="card" style={{ marginTop: 16 }} data-testid="sandbox-reset-progress">
          <p className="cardBody">
            {t(locale, 'settings.sandboxResetJobStatus', {
              status: job.status,
              stage: job.stage ?? '—',
              progress: job.progress,
            })}
          </p>
          {job.status === 'SUCCEEDED' ? (
            <pre className="cardBody" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {JSON.stringify(job.report ?? {}, null, 2)}
            </pre>
          ) : null}
          {job.error ? <p style={{ color: '#b91c1c' }}>{job.error}</p> : null}
          {job.status === 'QUEUED' ? (
            <button
              type="button"
              className="button buttonGhost"
              disabled={busy}
              onClick={() => void cancelJob(job.jobId)}
            >
              {t(locale, 'settings.sandboxResetCancelJob')}
            </button>
          ) : null}
        </section>
      ) : null}

      {notice ? <p className="cardBody">{notice}</p> : null}

      <div style={{ marginTop: 16, display: 'grid', gap: 8, maxWidth: 560 }}>
        <label>
          {t(locale, 'settings.sandboxResetConfirmLabel')}
          <input
            style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}
            data-testid="sandbox-reset-confirm-input"
            value={confirmText}
            placeholder={CONFIRM_PHRASE}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </label>
        <label>
          {t(locale, 'settings.sandboxResetReasonLabel')}
          <input
            style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}
            data-testid="sandbox-reset-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <legend>{t(locale, 'settings.sandboxResetScopeLabel')}</legend>
          {(
            [
              ['courses', 'settings.sandboxResetScopeCourses'],
              ['media', 'settings.sandboxResetScopeMedia'],
              ['staging', 'settings.sandboxResetScopeStaging'],
              ['packageJobs', 'settings.sandboxResetScopePackageJobs'],
              ['resetCodeCounters', 'settings.sandboxResetScopeResetCodeCounters'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={scope[key]}
                onChange={(event) => setScope((current) => ({ ...current, [key]: event.target.checked }))}
              />{' '}
              {t(locale, label)}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="button"
          data-testid="sandbox-reset-start"
          disabled={!canContinue || busy || active}
          onClick={() => setShowConfirm(true)}
        >
          {t(locale, 'settings.sandboxResetStart')}
        </button>
      </div>

      {showConfirm ? (
        <div
          style={{ marginTop: 16, border: '1px solid #fca5a5', borderRadius: 8, padding: 12, background: '#fef2f2' }}
          data-testid="sandbox-reset-confirm-panel"
        >
          <p className="cardBody" style={{ fontWeight: 600 }}>
            {t(locale, 'settings.sandboxResetConfirmTitle')}
          </p>
          <p className="cardBody">{t(locale, 'settings.sandboxResetConfirmBody')}</p>
          <button
            type="button"
            className="button"
            data-testid="sandbox-reset-confirm"
            disabled={busy}
            onClick={() => void startReset()}
          >
            {t(locale, 'settings.sandboxResetConfirmButton')}
          </button>{' '}
          <button
            type="button"
            className="button buttonGhost"
            disabled={busy}
            onClick={() => setShowConfirm(false)}
          >
            {t(locale, 'settings.sandboxResetCancel')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
