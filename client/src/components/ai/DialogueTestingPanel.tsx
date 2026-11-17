import { useEffect, useRef, useState } from 'react'
import { App, Button, Card, Empty, Input, Select, Space, Switch, Tag, Alert } from '../ui'
import { chatStream, type AiMode } from '../../api/ai'
import { useAiStore } from '../../stores/aiStore'
import { TutorMarkdown } from './TutorMarkdown'
import { useAiText } from './i18n'

type RunningSolution = 'grounded-jack' | 'dialogue-yong'
type Route = { id: string; model: string; releaseId: string; useKnowledge: boolean; runningSolution: RunningSolution }
type Result = { question: string; answer: string; mode: AiMode; model: string; releaseId: string; useKnowledge: boolean; runningSolution: RunningSolution; status: 'streaming' | 'complete' | 'error' | 'aborted'; error?: string; createdAt: string }
type Saved = { routes: Route[]; results: Record<string, Result[]> }

const storageKey = (ownerId: string, courseId: string) => `aitutor.dialogue-testing.v1.${JSON.stringify([ownerId, courseId])}`

function load(ownerId: string, courseId: string): Saved | null {
  try {
    const raw = localStorage.getItem(storageKey(ownerId, courseId))
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    if (!Array.isArray(saved.routes) || !saved.results || typeof saved.results !== 'object') return null
    return { routes: saved.routes.map((route) => ({ ...route, runningSolution: route.runningSolution === 'dialogue-yong' ? 'dialogue-yong' as const : 'grounded-jack' as const })), results: Object.fromEntries(Object.entries(saved.results).map(([id, items]) => [id, Array.isArray(items) ? items.map((item) => item.status === 'streaming' ? { ...item, status: 'aborted' } : item) : []])) }
  } catch { return null }
}

export function DialogueTestingPanel() {
  const { text, modeLabel } = useAiText()
  const { message } = App.useApp()
  const ownerId = useAiStore((s) => s.ownerId)
  const courseId = useAiStore((s) => s.selectedCourseId)
  const config = useAiStore((s) => s.config)
  const models = useAiStore((s) => s.models)
  const releases = useAiStore((s) => s.releases)
  const [mode, setMode] = useState<AiMode>('LECTURE')
  const [routes, setRoutes] = useState<Route[]>(() => ownerId && courseId ? load(ownerId, courseId)?.routes ?? [] : [])
  const [results, setResults] = useState<Record<string, Result[]>>(() => ownerId && courseId ? load(ownerId, courseId)?.results ?? {} : {})
  const [question, setQuestion] = useState('')
  const [running, setRunning] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const key = ownerId && courseId ? storageKey(ownerId, courseId) : ''
  const storageWarning = text('dialogueTesting.storageError')

  useEffect(() => {
    return () => controller.current?.abort()
  }, [])

  useEffect(() => {
    if (key) {
      try { localStorage.setItem(key, JSON.stringify({ routes, results })) }
      catch { message.warning(storageWarning) }
    }
  }, [key, routes, results, message, storageWarning])

  const addRoute = () => {
    const model = config?.model && models.includes(config.model) ? config.model : models[0]
    const releaseId = config?.releaseId ?? releases[0]?.id
    if (!model || !releaseId) return
    setRoutes((current) => [...current, { id: crypto.randomUUID(), model, releaseId, useKnowledge: true, runningSolution: config?.runningSolution ?? 'grounded-jack' }])
  }

  const updateRoute = (id: string, change: Partial<Route>) => {
    setRoutes((current) => current.map((route) => route.id === id ? { ...route, ...change } : route))
    setResults((current) => ({ ...current, [id]: [] }))
  }

  const sendAll = async () => {
    const input = question.trim()
    if (!ownerId || !courseId || !input || !routes.length || running) return
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    try {
      for (const route of routes) {
        if (abort.signal.aborted) break
        const previous = results[route.id] ?? []
        const history = previous.filter((item) => item.status === 'complete').flatMap((item) => [
          { role: 'user' as const, content: item.question },
          { role: 'assistant' as const, content: item.answer },
        ]).slice(-20)
        const next: Result = { question: input, answer: '', mode, model: route.model, releaseId: route.releaseId, useKnowledge: route.useKnowledge, runningSolution: route.runningSolution, status: 'streaming', createdAt: new Date().toISOString() }
        try {
          await chatStream({ courseId, releaseId: route.releaseId, model: route.model, useKnowledge: route.useKnowledge, runningSolution: route.runningSolution, message: input, mode, history }, (event) => {
            if ('delta' in event) {
              next.answer += event.delta
              setResults((current) => ({ ...current, [route.id]: [...previous, { ...next }] }))
            }
          }, abort.signal, '/api/ai/dialogue-test-stream')
          next.status = 'complete'
        } catch (error) {
          next.status = abort.signal.aborted ? 'aborted' : 'error'
          next.error = error instanceof Error ? error.message : String(error)
        }
        setResults((current) => ({ ...current, [route.id]: [...previous, { ...next }] }))
      }
      if (!abort.signal.aborted) setQuestion('')
    } finally {
      if (controller.current === abort) controller.current = null
      setRunning(false)
    }
  }

  return <Card title={text('dialogueTesting.title')} style={{ height: '100%', overflow: 'auto' }}>
    {!courseId ? <Empty description={text('pickCourseFirst')} /> : <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Select value={mode} onChange={(value) => setMode(value as AiMode)} options={(['LECTURE', 'SOCRATIC'] as const).map((value) => ({ value, label: modeLabel(value) }))} style={{ minWidth: 140 }} disabled={running} />
        <Button onClick={addRoute} disabled={running || !models.length || !releases.length || routes.length >= 4}>{text('dialogueTesting.addRoute')}</Button>
        <Button onClick={() => { setResults({}); setQuestion('') }} disabled={running}>{text('newChat')}</Button>
      </Space>
      {routes.length === 0 && <Empty description={text('dialogueTesting.noRoutes')} />}
      <Input.TextArea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={text('inputPlaceholder')} disabled={running || routes.length === 0} autoSize={{ minRows: 2, maxRows: 5 }} />
      <Space>
        <Button type="primary" onClick={() => void sendAll()} disabled={running || !question.trim() || !routes.length}>{text('dialogueTesting.runAll')}</Button>
        {running && <Button onClick={() => controller.current?.abort()}>{text('stop')}</Button>}
      </Space>
      {routes.map((route, index) => <Card key={route.id} size="small" title={`${text('dialogueTesting.route')} ${index + 1}`} extra={<Button type="text" danger disabled={running} onClick={() => { setRoutes((current) => current.filter((item) => item.id !== route.id)); setResults((current) => { const next = { ...current }; delete next[route.id]; return next }) }}>{text('dialogueTesting.remove')}</Button>}>
        <Space wrap>
          <Select value={route.model} onChange={(model) => updateRoute(route.id, { model })} options={models.map((model) => ({ value: model, label: model }))} style={{ minWidth: 180 }} disabled={running} />
          <Select value={route.releaseId} onChange={(releaseId) => updateRoute(route.id, { releaseId })} options={releases.map((release) => ({ value: release.id, label: release.versionTag }))} style={{ minWidth: 160 }} disabled={running} />
          <Select value={route.runningSolution ?? 'grounded-jack'} onChange={(runningSolution) => updateRoute(route.id, { runningSolution })} options={[{ value: 'grounded-jack', label: 'Grounded Tutor - Jack' }, { value: 'dialogue-yong', label: 'Dialogue Tutor - Yong' }]} style={{ minWidth: 180 }} disabled={running} />
          <Switch checked={route.useKnowledge} onChange={(useKnowledge) => updateRoute(route.id, { useKnowledge })} disabled={running} /> {text('dialogueTesting.useKnowledge')}
        </Space>
        {(results[route.id] ?? []).map((result, i) => <div key={`${result.createdAt}-${i}`} style={{ marginTop: 16 }}>
          <Space><Tag color={result.status === 'complete' ? 'green' : result.status === 'error' ? 'red' : 'default'}>{text(`dialogueTesting.${result.status}`)}</Tag><span>{result.runningSolution === 'dialogue-yong' ? 'Dialogue Tutor - Yong' : 'Grounded Tutor - Jack'} · {result.model} · {releases.find((item) => item.id === result.releaseId)?.versionTag ?? result.releaseId}</span></Space>
          <p><strong>{text('dialogueTesting.question')}</strong> {result.question}</p>
          {result.answer && <TutorMarkdown content={result.answer} courseId={courseId} sourcesLabel={text('sources')} />}
          {result.error && <Alert type="error" message={result.error} />}
        </div>)}
      </Card>)}
    </Space>}
  </Card>
}
