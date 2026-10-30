import { useEffect, useId, useRef, useState } from 'react'

import type { FlywheelJobRun, PortalJobRun, PortalJobRuns } from '../contracts/helpdesk'
import {
  getJobRun,
  listJobRuns,
  listRetentionRuns,
  newIdempotencyKey,
  runJobNow,
  runRetentionNow,
  type HelpdeskResult,
} from '../lib/helpdeskApi'
import { miningRunSummary } from '../lib/helpdeskFlywheel'
import { errorMessage } from '../lib/helpdeskFormat'
import { cardTime, longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * FAQ 候选页顶上的「后台任务」（v5 Part G3「立即运行」，待视觉验收）：
 * - Admin 的夜间缺口挖掘：最近一次（时间、定时 / 谁手动、结果与计数）；「立即运行」带 Idempotency-Key，
 *   201 后台开跑 → 每秒轮询这次运行，结束后提示计数并让队列刷新；正在跑 → 409，提示稍后再试。
 * - Portal 的学员原文保留任务（180 天后只留脱敏文字与标签）：最近一次与「立即运行」（Portal 同步跑完）。
 * 「立即运行」只给 FULL（服务端同样拒绝并写审计）。网络断了（没拿到响应）重试沿用同一个 key。
 */

export const RUN_POLL_MS = 1000
const RUN_POLL_MAX = 180

type Props = { locale: Locale; canWrite: boolean; onMiningFinished: () => void }

/** 「立即运行」（只给 FULL；读屏读出是哪个任务）。 */
function RunButton({ locale, name, busy, onRun }: { locale: Locale; name: string; busy: boolean; onRun: () => void }) {
  return (
    <button
      type="button"
      className="hdDrawerButton"
      disabled={busy}
      aria-label={t(locale, 'helpDesk.candidates.jobs.runNowLabel', { job: name })}
      onClick={onRun}
    >
      {t(locale, busy ? 'helpDesk.candidates.jobs.running' : 'helpDesk.candidates.jobs.runNow')}
    </button>
  )
}
type Loaded<T> = { ok: true; data: T } | { ok: false; code: string } | null

const when = (iso: string | null, locale: Locale) => (iso ? `${longDate(iso, locale)} ${cardTime(iso, locale)}` : '—')

function settled<T>(result: HelpdeskResult<T>): Loaded<T> {
  return result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code }
}

export function FlywheelJobs({ locale, canWrite, onMiningFinished }: Props) {
  const uid = useId()
  const [mining, setMining] = useState<Loaded<{ runs: FlywheelJobRun[] }>>(null)
  const [retention, setRetention] = useState<Loaded<PortalJobRuns>>(null)
  const [miningBusy, setMiningBusy] = useState(false)
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const live = useRef(true)
  const miningKey = useRef<string | null>(null)
  const retentionKey = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finished = useRef(onMiningFinished)
  useEffect(() => {
    finished.current = onMiningFinished
  })

  const loadMining = () => listJobRuns('gap_mining').then((result) => live.current && setMining(settled(result)))
  const loadRetention = () => listRetentionRuns().then((result) => live.current && setRetention(settled(result)))

  useEffect(() => {
    live.current = true
    void listJobRuns('gap_mining').then((result) => live.current && setMining(settled(result)))
    void listRetentionRuns().then((result) => live.current && setRetention(settled(result)))
    return () => {
      live.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function poll(runId: string, left: number) {
    timer.current = setTimeout(async () => {
      timer.current = null
      if (!live.current) return
      const result = await getJobRun('gap_mining', runId)
      if (!live.current) return
      if (result.ok && result.data.status === 'running') {
        if (left > 1) return poll(runId, left - 1)
        setNotice({ tone: 'info', text: t(locale, 'helpDesk.candidates.jobs.stillRunning') })
      } else if (result.ok && result.data.status === 'succeeded') {
        const { created, grown } = miningRunSummary(result.data.stats)
        setNotice({ tone: 'info', text: t(locale, 'helpDesk.candidates.jobs.finished', { created, grown }) })
        finished.current()
      } else if (result.ok) {
        setNotice({ tone: 'error', text: t(locale, 'helpDesk.candidates.jobs.failed', { code: result.data.errorCode ?? 'error' }) })
        finished.current()
      } else {
        setNotice({ tone: 'error', text: errorMessage(locale, result.code) })
      }
      setMiningBusy(false)
      void loadMining()
    }, RUN_POLL_MS)
  }

  async function runMining() {
    if (miningBusy) return
    setMiningBusy(true)
    setNotice(null)
    miningKey.current ??= newIdempotencyKey()
    const result = await runJobNow('gap_mining', miningKey.current)
    if (!live.current) return
    // 拿到了响应（成功或明确的拒绝）：下一次是新的一次；网络断了沿用同一个 key
    if (result.ok || result.status !== 0) miningKey.current = null
    if (!result.ok) {
      setNotice({ tone: 'error', text: errorMessage(locale, result.code) })
      setMiningBusy(false)
      return
    }
    setNotice({ tone: 'info', text: t(locale, 'helpDesk.candidates.jobs.started') })
    void loadMining()
    poll(result.data.id, RUN_POLL_MAX)
  }

  async function runRetention() {
    if (retentionBusy) return
    setRetentionBusy(true)
    setNotice(null)
    retentionKey.current ??= newIdempotencyKey()
    const result = await runRetentionNow(retentionKey.current)
    if (!live.current) return
    if (result.ok || result.status !== 0) retentionKey.current = null
    if (!result.ok) setNotice({ tone: 'error', text: errorMessage(locale, result.code) })
    else if (result.data.outcome === 'already_running')
      setNotice({ tone: 'info', text: t(locale, 'helpDesk.candidates.jobs.retentionBusy') })
    else
      setNotice({
        tone: 'info',
        text: t(locale, 'helpDesk.candidates.jobs.retentionDone', { rows: result.data.run?.rowsScrubbed ?? 0 }),
      })
    setRetentionBusy(false)
    void loadRetention()
  }

  function trigger(run: { trigger: string; requestedBy: { name: string } | null }): string {
    if (run.trigger !== 'manual') return t(locale, 'helpDesk.candidates.jobs.schedule')
    return run.requestedBy?.name
      ? t(locale, 'helpDesk.candidates.jobs.manual', { name: run.requestedBy.name })
      : t(locale, 'helpDesk.candidates.jobs.manualNoName')
  }

  function status(run: { status: string; errorCode: string | null }): string {
    if (run.status === 'failed') return t(locale, 'helpDesk.candidates.jobs.failedCode', { code: run.errorCode ?? 'error' })
    return t(locale, `helpDesk.candidates.jobs.status.${run.status}`)
  }

  const miningName = t(locale, 'helpDesk.candidates.jobs.gap_mining')
  const retentionName = t(locale, 'helpDesk.candidates.jobs.assist_retention', {
    days: retention?.ok ? retention.data.retentionDays : 180,
  })
  const lastMining = mining?.ok ? (mining.data.runs[0] ?? null) : null
  const lastRetention: PortalJobRun | null = retention?.ok ? (retention.data.runs[0] ?? null) : null

  function miningResult(run: FlywheelJobRun) {
    const summary = miningRunSummary(run.stats)
    const counts = { received: summary.received, created: summary.created, grown: summary.grown }
    return (
      <>
        <span className="hdReleaseResult">{status(run)}</span>
        {run.status !== 'running' ? (
          <span className="hdReleaseResult hdGraphHint">{t(locale, 'helpDesk.candidates.jobs.miningResult', counts)}</span>
        ) : null}
        {summary.pull === 'not_connected' ? (
          <span className="hdReleaseResult hdGraphHint">{t(locale, 'helpDesk.candidates.jobs.pullNotConnected')}</span>
        ) : null}
        {run.moreDue ? <span className="hdReleaseResult hdGraphHint">{t(locale, 'helpDesk.candidates.jobs.moreDue')}</span> : null}
      </>
    )
  }

  function retentionResult(run: PortalJobRun) {
    return (
      <>
        <span className="hdReleaseResult">{status(run)}</span>
        <span className="hdReleaseResult hdGraphHint">{t(locale, 'helpDesk.candidates.jobs.retentionResult', { rows: run.rowsScrubbed })}</span>
        {run.moreDue ? <span className="hdReleaseResult hdGraphHint">{t(locale, 'helpDesk.candidates.jobs.moreDue')}</span> : null}
      </>
    )
  }

  const retentionDown = retention !== null && !retention.ok

  return (
    <section className="hdFlywheelJobs" aria-labelledby={`${uid}-jobs`}>
      <h2 className="hdGraphTitle" id={`${uid}-jobs`}>
        {t(locale, 'helpDesk.candidates.jobs.title')}
      </h2>
      <div className={`hdNotice hdJobsNotice${notice?.tone === 'error' ? ' hdDrawerAlert' : ''}`} role="status" hidden={!notice}>
        {notice?.text}
      </div>
      <div className="hdFaqTableWrap hdJobsTableWrap">
        <table className="hdFaqTable hdReleaseTable" aria-labelledby={`${uid}-jobs`}>
          <thead>
            <tr>
              {(['job', 'lastRun', 'result', 'action'] as const).map((column) => (
                <th key={column} scope="col">
                  {t(locale, `helpDesk.candidates.jobs.columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{miningName}</th>
              <td className="hdFaqDate">
                {lastMining ? (
                  <>
                    {when(lastMining.startedAt, locale)}
                    <span className="hdReleaseResult hdGraphHint">{trigger(lastMining)}</span>
                  </>
                ) : mining?.ok ? (
                  t(locale, 'helpDesk.candidates.jobs.never')
                ) : null}
              </td>
              <td>{mining && !mining.ok ? errorMessage(locale, mining.code) : lastMining ? miningResult(lastMining) : null}</td>
              <td>
                {canWrite ? <RunButton locale={locale} name={miningName} busy={miningBusy} onRun={() => void runMining()} /> : null}
              </td>
            </tr>
            <tr>
              <th scope="row">{retentionName}</th>
              <td className="hdFaqDate">
                {lastRetention ? (
                  <>
                    {when(lastRetention.startedAt, locale)}
                    <span className="hdReleaseResult hdGraphHint">{trigger(lastRetention)}</span>
                  </>
                ) : retention?.ok ? (
                  t(locale, 'helpDesk.candidates.jobs.never')
                ) : null}
              </td>
              <td>
                {retention && !retention.ok
                  ? errorMessage(locale, retention.code)
                  : lastRetention
                    ? retentionResult(lastRetention)
                    : null}
              </td>
              <td>
                {canWrite && !retentionDown ? (
                  <RunButton locale={locale} name={retentionName} busy={retentionBusy} onRun={() => void runRetention()} />
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
