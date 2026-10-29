import { useEffect, useId, useRef, useState } from 'react'

import type { AgentRun } from '../contracts/helpdesk'
import { getAgentRun } from '../lib/helpdeskApi'
import { traceView, type TraceDetail } from '../lib/helpdeskTrace'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useModal } from './useModal'

/**
 * 「查看链路」抽屉（helpdesk-agent-v2-pi-dsh §2）：一个 AI 块对应的 run，只读。
 * 概要（结束原因、模型、token、费用、耗时、选中的 FAQ、候选、trace id、同段对话的 run 数）+ 按 seq 排的事件
 *（距第一条的时间偏移、dsh 事件类型、第几步、模型 / token / 费用 / 候选 / 工具参数 / 错误 / 结束原因）。
 * 数据是服务端的导出副本，学员原文已脱敏。helpDesk 的 VIEW 及以上都能打开；没有任何写控件。
 * Figma 没有画板：沿用 FAQ 抽屉的外壳与样式（待视觉验收）。模态层同 FAQ 抽屉（useModal，Escape 关闭，焦点还给入口）。
 */

type Props = { locale: Locale; runId: string; onClose: () => void }
type State = { kind: 'loading' } | { kind: 'ready'; run: AgentRun } | { kind: 'missing' } | { kind: 'failed' }

/** 新的结束原因还没有文案时原样显示。 */
function reasonLabel(locale: Locale, reason: string): string {
  const key = `helpDesk.trace.reasons.${reason}`
  const label = t(locale, key)
  return label === key ? reason : label
}
function feedbackLabel(locale: Locale, outcome: string): string {
  const key = `helpDesk.trace.feedbackValues.${outcome}`
  const label = t(locale, key)
  return label === key ? outcome : label
}
const cost = (locale: Locale, usd: number | null) => (usd === null ? t(locale, 'helpDesk.trace.unknown') : `$${usd.toFixed(6)}`)

/** 距第一条事件：毫秒、秒、分钟、小时、天（反馈可能隔天才来）。 */
function offsetLabel(locale: Locale, ms: number | null): string {
  if (ms === null) return t(locale, 'helpDesk.trace.none')
  const unit = (key: string, value: number | string) => t(locale, `helpDesk.trace.offset.${key}`, { value })
  if (ms < 1_000) return unit('ms', Math.round(ms))
  if (ms < 60_000) return unit('s', (Math.floor(ms / 100) / 10).toFixed(1))
  if (ms < 3_600_000) return unit('min', Math.floor(ms / 60_000))
  if (ms < 86_400_000) return unit('h', Math.floor(ms / 3_600_000))
  return unit('d', Math.floor(ms / 86_400_000))
}

/** 每种明细在 helpDesk.trace.fields 下有同名文案。 */
const detailLabel = (locale: Locale, detail: TraceDetail) => t(locale, `helpDesk.trace.fields.${detail.kind}`)

function detailValue(locale: Locale, detail: TraceDetail): string {
  switch (detail.kind) {
    case 'tokens':
      return t(locale, 'helpDesk.trace.tokensValue', { input: detail.input, output: detail.output })
    case 'cost':
      return cost(locale, detail.usd)
    case 'rejectedArgs':
      return t(locale, 'helpDesk.trace.rejectedArgsValue', { length: detail.length })
    case 'candidates':
      return detail.ids.join(', ')
    case 'chosen':
      return detail.faqId
    case 'endReason':
      return reasonLabel(locale, detail.value)
    case 'feedback':
      return feedbackLabel(locale, detail.value)
    default:
      return detail.value
  }
}

export function TraceDrawer({ locale, runId, onClose }: Props) {
  const uid = useId()
  const titleId = `${uid}-title`
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void getAgentRun(runId).then((result) => {
      if (!live) return
      if (result.ok) setState({ kind: 'ready', run: result.data })
      else setState({ kind: result.code === 'AGENT_RUN_NOT_FOUND' ? 'missing' : 'failed' })
    })
    return () => {
      live = false
    }
  }, [runId, attempt])

  const retry = () => {
    setState({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  // 打开时焦点进抽屉，关闭时还给打开它的「查看链路」
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useModal(() => drawerRef.current, onClose)

  const none = t(locale, 'helpDesk.trace.none')
  const view = state.kind === 'ready' ? traceView(state.run) : null
  const summary = view?.summary
  const fields: [string, string][] = summary
    ? [
        ['endReason', summary.endReason ? reasonLabel(locale, summary.endReason) : none],
        ['model', summary.model ?? none],
        [
          'tokens',
          summary.inputTokens === null && summary.outputTokens === null
            ? none
            : t(locale, 'helpDesk.trace.tokensValue', { input: summary.inputTokens ?? 0, output: summary.outputTokens ?? 0 }),
        ],
        ['cost', summary.costUnknown ? cost(locale, null) : summary.costUsd === null ? none : cost(locale, summary.costUsd)],
        ['latency', summary.latencyMs === null ? none : t(locale, 'helpDesk.trace.latencyValue', { ms: summary.latencyMs })],
        ['chosen', summary.chosenFaqId ?? none],
        ['candidates', summary.candidates.length > 0 ? summary.candidates.join(', ') : none],
        ['traceId', summary.traceId ?? none],
        ['conversation', t(locale, 'helpDesk.trace.conversationValue', { count: summary.chainLength })],
        ['feedback', summary.feedback ? feedbackLabel(locale, summary.feedback) : none],
      ]
    : []

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={onClose} />
      <aside ref={drawerRef} className="hdDrawer hdTraceDrawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={titleId}>
              {t(locale, 'helpDesk.trace.title')}
            </h2>
            <p className="hdDrawerSubtitle">{t(locale, 'helpDesk.trace.subtitle')}</p>
          </div>
          <button ref={closeRef} type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.trace.close')} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="hdDrawerBody hdTraceBody">
          {state.kind === 'loading' ? <p className="hdMuted">{t(locale, 'helpDesk.trace.loading')}</p> : null}
          {state.kind === 'missing' ? (
            <p className="hdNotice hdDrawerNotice" role="status">
              {t(locale, 'helpDesk.trace.notFound')}
            </p>
          ) : null}
          {state.kind === 'failed' ? (
            <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
              <p>{t(locale, 'helpDesk.trace.failed')}</p>
              <button type="button" className="hdLinkButton" onClick={retry}>
                {t(locale, 'helpDesk.trace.retry')}
              </button>
            </div>
          ) : null}
          {view ? (
            <>
              <section role="group" aria-label={t(locale, 'helpDesk.trace.summaryTitle')}>
                <h3 className="hdTraceHeading">{t(locale, 'helpDesk.trace.summaryTitle')}</h3>
                <dl className="hdTraceSummary">
                  {fields.map(([key, value]) => (
                    <div key={key} className="hdTraceField">
                      <dt>{t(locale, `helpDesk.trace.fields.${key}`)}</dt>
                      <dd className="hdTraceValue">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <h3 className="hdTraceHeading" id={`${uid}-events`}>
                {t(locale, 'helpDesk.trace.eventsTitle')}
              </h3>
              <ol className="hdTraceEvents" aria-labelledby={`${uid}-events`}>
                {view.rows.map((row) => (
                  <li key={row.seq} className="hdTraceEvent">
                    <div className="hdTraceEventHead">
                      <span className="hdTraceOffset">{offsetLabel(locale, row.offsetMs)}</span>{' '}
                      <code className="hdTraceType">{row.type}</code>
                      {row.step !== null ? (
                        <span className="hdTraceStep">
                          {' '}
                          {t(locale, 'helpDesk.trace.stepValue', { step: row.step })}
                          {row.name ? ` · ${row.name}` : ''}
                        </span>
                      ) : null}
                    </div>
                    {row.details.length > 0 ? (
                      <dl className="hdTraceDetails">
                        {row.details.map((detail, index) => (
                          <div key={index} className={`hdTraceField${detail.kind === 'error' ? ' hdTraceError' : ''}`}>
                            <dt>{detailLabel(locale, detail)}</dt>
                            <dd className="hdTraceValue">{detailValue(locale, detail)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
