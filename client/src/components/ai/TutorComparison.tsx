import './evaluation.css'
import { useEffect, useRef, useState } from 'react'
import { App, Button, Input, Select, Space, Alert } from '../ui'
import { http } from '../../api/client'
import { chatStream } from '../../api/ai'
import { TutorMarkdown } from './TutorMarkdown'
import { evaluationText } from './evaluationText'

export type ComparisonConfig = { courseId: string; releaseId: string; model: string; runningSolution: 'grounded-jack' | 'dialogue-yong'; modes: Array<'LECTURE' | 'SOCRATIC'>; kind: 'single' | 'multi' }
type Turn = { question: string; answer: string; status: 'running' | 'success' | 'failed'; error?: string; latencyMs: number }
type Route = { id: string; config: ComparisonConfig; turns: Turn[] }
type Props = { initial: ComparisonConfig; models: string[]; releases: Array<{ id: string; versionTag: string }>; en: boolean }

function AnswerHistory({ turns, courseId, en, label }: { turns: Turn[]; courseId: string; en: boolean; label: string }) {
  const zh = !en
  const list = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const el = list.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [turns])
  return <div ref={list} role="log" aria-label={label} tabIndex={0} className="ai-test-scroll ai-tutor-answers" onScroll={() => {
    const el = list.current
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }}>{turns.map((turn, i) => <div key={i}>
    <p><strong>{turn.question}</strong></p>
    <TutorMarkdown content={turn.answer} courseId={courseId} sourcesLabel={zh ? '来源' : 'Sources'} />
    <div>{evaluationText(turn.status, en)} · {(turn.latencyMs / 1000).toFixed(1)}s</div>
    {turn.error && <Alert type="error" message={evaluationText(turn.error, en)} />}
  </div>)}</div>
}

export function TutorComparison({ initial, models, releases, en }: Props) {
  const L = (zh: string, english: string) => en ? english : zh
  const { message } = App.useApp()
  const [routes, setRoutes] = useState<Route[]>(() => [{ id: crypto.randomUUID(), config: { ...initial, modes: [initial.modes[0]] }, turns: [] }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sessions = useRef(new Map<string, string>())
  const controllers = useRef(new Map<string, AbortController>())
  const active = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; const currentControllers = controllers.current; return () => { mounted.current = false; currentControllers.forEach((c) => c.abort()) } }, [])
  const locked = busy || routes.some((r) => r.turns.length > 0)
  const update = (id: string, fn: (route: Route) => Route) => { if (mounted.current) setRoutes((values) => values.map((r) => r.id === id ? fn(r) : r)) }
  const patch = (id: string, config: Partial<ComparisonConfig>) => update(id, (r) => ({ ...r, config: { ...r.config, ...config } }))
  const run = async (route: Route, question: string, retry: boolean) => {
    const previous = retry ? route.turns.slice(0, -1) : route.turns
    const turn: Turn = { question, answer: '', status: 'running', latencyMs: 0 }
    update(route.id, (r) => ({ ...r, turns: [...previous, { ...turn }] }))
    const controller = new AbortController(), started = Date.now()
    controllers.current.set(route.id, controller)
    try {
      let session = sessions.current.get(route.id)
      if (!session) {
        session = (await http.post<{ id: string }>('/ai/evaluation/sessions', route.config, { signal: controller.signal })).data.id
        sessions.current.set(route.id, session)
      }
      const history = previous.filter((r) => r.status === 'success').flatMap((r) => [{ role: 'user' as const, content: r.question }, { role: 'assistant' as const, content: r.answer }])
      await chatStream({ courseId: route.config.courseId, mode: route.config.modes[0], message: question, history }, (event) => {
        if ('delta' in event) { turn.answer += event.delta; update(route.id, (r) => ({ ...r, turns: [...previous, { ...turn }] })) }
      }, controller.signal, `/api/ai/evaluation/sessions/${session}/answer`)
      turn.status = 'success'
    } catch (e) {
      turn.status = 'failed'
      turn.error = controller.signal.aborted ? 'USER_STOPPED_INCOMPLETE' : (e as Error).message
    } finally {
      turn.latencyMs = Date.now() - started
      update(route.id, (r) => ({ ...r, turns: [...previous, { ...turn }] }))
      controllers.current.delete(route.id)
    }
  }
  const send = async (retryRoute?: Route) => {
    if (active.current) return
    const question = retryRoute ? retryRoute.turns.at(-1)!.question : input.trim()
    if (!question || routes.some((r) => !r.config.releaseId || !r.config.model)) return
    if (!retryRoute && routes.some((r) => r.turns.at(-1)?.status === 'failed')) return
    active.current = true; setBusy(true)
    if (!retryRoute) setInput('')
    try { await Promise.allSettled((retryRoute ? [retryRoute] : routes).map((r) => run(r, question, Boolean(retryRoute)))) }
    finally { active.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="ai-comparison">
    <Space>
      <Button disabled={locked || routes.length === 2} onClick={() => setRoutes((values) => values.length >= 2 ? values : [...values, { id: crypto.randomUUID(), config: { ...values[0].config, runningSolution: values[0].config.runningSolution === 'grounded-jack' ? 'dialogue-yong' : 'grounded-jack' }, turns: [] }])}>{L('添加对比', 'Add comparison')}</Button>
      <Button disabled={busy} onClick={() => { sessions.current.clear(); setRoutes((values) => values.map((r) => ({ ...r, turns: [] }))); setInput('') }}>{L('新测试', 'New test')}</Button>
      <Button disabled={!busy} onClick={() => controllers.current.forEach((c) => c.abort())}>{L('停止全部', 'Stop all')}</Button>
      <Button disabled={busy || !routes.some((r) => r.turns.length)} onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(routes, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'tutor-comparison.json'; a.click(); URL.revokeObjectURL(url) }}>{L('导出对比', 'Export comparison')}</Button>
    </Space>
    <div className="ai-tutor-grid" data-count={routes.length} style={{ gridTemplateColumns: `repeat(${routes.length}, minmax(0, 1fr))` }}>
      {routes.map((route, index) => <section key={route.id} aria-label={`Tutor ${index + 1}`} className="ai-tutor-panel">
        <div className="ai-tutor-heading"><strong>Tutor {index + 1}</strong>{routes.length === 2 && <Button disabled={locked} onClick={() => setRoutes((values) => values.filter((r) => r.id !== route.id))}>{L('移除', 'Remove')}</Button>}</div>
        <div className="ai-tutor-config">
          <Select aria-label={`Tutor ${index + 1} method`} disabled={locked} value={route.config.runningSolution} onChange={(runningSolution) => patch(route.id, { runningSolution })} options={[{ value: 'grounded-jack', label: 'Jack' }, { value: 'dialogue-yong', label: 'Yong' }]} style={{ width: '100%' }} />
          <Select title={route.config.model} aria-label={`Tutor ${index + 1} model`} disabled={locked} value={route.config.model} onChange={(model) => patch(route.id, { model })} options={models.map((value) => ({ value, label: value.split('/').at(-1) }))} style={{ width: '100%' }} />
          <Select title={releases.find((r) => r.id === route.config.releaseId)?.versionTag} aria-label={`Tutor ${index + 1} release`} disabled={locked} value={route.config.releaseId} onChange={(releaseId) => patch(route.id, { releaseId })} options={releases.map((r) => ({ value: r.id, label: r.versionTag }))} style={{ width: '100%' }} />
          <Select aria-label={`Tutor ${index + 1} mode`} disabled={locked} value={route.config.modes[0]} onChange={(mode) => patch(route.id, { modes: [mode] })} options={[{ value: 'LECTURE', label: 'Lecture' }, { value: 'SOCRATIC', label: 'Socratic' }]} style={{ width: '100%' }} />
        </div>
        <AnswerHistory turns={route.turns} courseId={route.config.courseId} en={en} label={`Tutor ${index + 1} answers`} />
          {route.turns.at(-1)?.status === 'running' && <Button onClick={() => controllers.current.get(route.id)?.abort()}>{L('停止此侧', 'Stop this side')}</Button>}
          {route.turns.at(-1)?.status === 'failed' && <Button disabled={busy} onClick={() => void send(route)}>{L('重试此侧', 'Retry this side')}</Button>}
      </section>)}
    </div>
    {routes.some((r) => r.turns.at(-1)?.status === 'failed') && <Alert type="info" message={L('请重试失败侧，或开始新测试，再继续共同追问。', 'Retry the failed side or start a new test before sending another shared question.')} />}
    <div className="ai-composer">
    <Input.TextArea aria-label={L('共同问题', 'Shared question')} value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} placeholder={L('输入发送给所有Tutor的问题或追问', 'Question or follow-up for all tutors')} />
    <Button disabled={busy || !input.trim() || routes.some((r) => r.turns.at(-1)?.status === 'failed' || !r.config.releaseId || !r.config.model)} onClick={() => { void send().catch((e: Error) => message.error(e.message)) }}>{L('发送', 'Send')}</Button>
    </div>
  </div>
}
