import './evaluation.css'
import { TutorComparison } from './TutorComparison'
import { evaluationText } from './evaluationText'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Input, Modal, Select, Space, Tabs } from '../ui'
import { http } from '../../api/client'
import { useAiStore } from '../../stores/aiStore'
import { useLocale } from '../../backoffice/lib/navigation'
import { TutorMarkdown } from './TutorMarkdown'
import { AiReleaseOption } from './AiReleaseOption'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccessState'

type Mode = 'LECTURE' | 'SOCRATIC'
type Question = { conversationId: string; turn: number; question: string; notes: string }
type Result = Question & { mode: Mode; answer: string; status: string; error: string | null; latencyMs: number }
type Config = { courseId: string; releaseId: string; model: string; runningSolution: 'grounded-jack' | 'dialogue-yong'; modes: Mode[]; kind: 'single' | 'multi' }
type Task = { id: string; name?: string; status: string; createdAt: string; results: Result[]; config: Config }
const root = '/ai/evaluation'
const activeTaskStatuses = new Set(['queued', 'running', 'stopping'])

export function EvaluationPanel({ open, close }: { open: boolean; close: () => void }) {
  const locale = useLocale(), en = locale === 'en-GB'
  const L = (zh: string, english: string) => en ? english : zh
  const { message, modal } = App.useApp()
  const { canEdit } = useWorkspaceAccess()
  const courseId = useAiStore((s) => s.selectedCourseId)
  const owner = useAiStore((s) => s.ownerId)
  const current = useAiStore((s) => s.config)
  const models = useAiStore((s) => s.models)
  const releases = useAiStore((s) => s.releases)
  const [config, setConfig] = useState<Config>({ courseId: courseId ?? '', releaseId: current?.releaseId ?? '', model: current?.model ?? models[0] ?? '', runningSolution: 'dialogue-yong', modes: ['LECTURE'], kind: 'multi' })
  const [tab, setTab] = useState('single')
  const [busy, setBusy] = useState(false)
  const [questions, setQuestions] = useState<Question[]>([])
  const [source, setSource] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<Task | null>(null)
  const [taskRefreshFailed, setTaskRefreshFailed] = useState(false)
  const [taskRefreshVersion, setTaskRefreshVersion] = useState(0)
  const refreshVersion = useRef(0)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const hasActiveTasks = useRef(false)
  const selectedId = useRef<string | null>(null)
  const selectionRequest = useRef(0)
  const selectTask = useCallback((task: Task | null) => {
    selectedId.current = task?.id ?? null
    setSelected(task)
  }, [])
  const submissionKey = useRef(crypto.randomUUID())
  const generation = useRef(0)
  const refreshTaskHistory = () => setTaskRefreshVersion(++refreshVersion.current)
  const patch = (value: Partial<Config>) => { generation.current++; setConfig((c) => ({ ...c, ...value })); submissionKey.current = crypto.randomUUID(); setQuestions([]); setSource(''); setErrors([]) }
  useEffect(() => {
    generation.current++
    selectionRequest.current++
    hasActiveTasks.current = false
    selectTask(null); setQuestions([]); setSource(''); setTasks([]); setTaskRefreshFailed(false); setRename(null)
    setConfig((c) => ({ ...c, courseId: courseId ?? '', releaseId: current?.releaseId ?? '', model: current?.model ?? models[0] ?? '' }))
  // Course/account are session boundaries; config edits must not reset the test.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, courseId, selectTask])
  useEffect(() => {
    if (!open || tab !== 'tasks') return
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const isCurrent = () => !signal.aborted && taskRefreshVersion === refreshVersion.current

    const refresh = async () => {
      try {
        const { data } = await http.get<Task[]>(`${root}/tasks`, { signal })
        if (!isCurrent()) return
        setTasks(data)
        hasActiveTasks.current = data.some((task) => activeTaskStatuses.has(task.status))

        const id = selectedId.current
        if (id) {
          try {
            const detail = await http.get<Task>(`${root}/tasks/${id}`, { signal })
            if (!isCurrent()) return
            if (selectedId.current === id) selectTask(detail.data)
          } catch (error) {
            if (!isCurrent()) return
            if (selectedId.current === id) {
              if ((error as { code?: string }).code !== 'NOT_FOUND') throw error
              selectTask(null)
              setTasks((currentTasks) => currentTasks.filter((task) => task.id !== id))
              hasActiveTasks.current = data.some((task) => task.id !== id && activeTaskStatuses.has(task.status))
            }
          }
        }
        failures = 0
        setTaskRefreshFailed(false)
      } catch {
        if (!isCurrent()) return
        failures++
        if (failures >= 2) setTaskRefreshFailed(true)
      }
      if (hasActiveTasks.current || failures === 1) {
        timer = setTimeout(() => void refresh(), 3000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [open, tab, owner, courseId, taskRefreshVersion, selectTask])

  const loadTask = async (id: string) => {
    const request = ++selectionRequest.current
    try {
      const { data } = await http.get<Task>(`${root}/tasks/${id}`)
      if (request === selectionRequest.current) selectTask(data)
    } catch (e) {
      if (request === selectionRequest.current) message.error(evaluationText((e as Error).message, en))
    }
  }
  const action = async (url: string, method: 'post' | 'delete' = 'post') => {
    try {
      await http[method](url)
      refreshTaskHistory()
    } catch (e) { message.error(evaluationText((e as Error).message, en)) }
  }

  const renameTask = async () => {
    const name = rename?.name.trim()
    if (!canEdit || !rename || !name || renaming) return
    setRenaming(true)
    try {
      const { data } = await http.patch<{ id: string; name: string }>(`${root}/tasks/${rename.id}/name`, { name })
      if (useAiStore.getState().ownerId !== owner) return
      selectionRequest.current++
      const withName = (task: Task) => task.id === data.id ? { ...task, name: data.name } : task
      setTasks((currentTasks) => currentTasks.map(withName))
      setSelected((currentTask) => currentTask ? withName(currentTask) : null)
      setRename(null)
      refreshTaskHistory()
    } catch (e) {
      message.error(evaluationText((e as Error).message, en))
    } finally {
      setRenaming(false)
    }
  }
  const upload = async (file: File) => {
    submissionKey.current = crypto.randomUUID(); setQuestions([]); setSource(''); setErrors([])
    if (file.size > 5 * 1024 * 1024) { setErrors([L('文件不能超过5MB', 'Maximum file size is 5 MB')]); return }
    const token = ++generation.current
    const form = new FormData(); form.append('file', file); form.append('config', JSON.stringify(config))
    setBusy(true)
    try {
      const response = await http.post<{ questions: Question[]; errors: string[]; mode: Mode }>(`${root}/validate`, form)
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
      if (generation.current !== token) return
setQuestions(response.data.questions); setErrors(response.data.errors); setSource(btoa(binary))
    } catch (e) { if (generation.current === token) setErrors([evaluationText((e as Error).message,en)]) }
    finally { setBusy(false) }
  }
  const selectedDone = selected?.results.filter((r) => r.status === 'success' || r.status === 'failed').length ?? 0
  const successful = selected?.results.filter((r) => r.status === 'success').length ?? 0
  const measured = selected?.results.filter((r) => r.latencyMs > 0) ?? []
  const remaining = selected ? selected.results.length - selectedDone : 0
  const estimate = measured.length ? Math.ceil(Math.max(3100, measured.reduce((sum, r) => sum + r.latencyMs, 0) / measured.length) * remaining / 60000) : null
  const locked = busy
  return <Modal open={open} onCancel={close} footer={null} width={1050} style={{ top: '7.5vh', paddingBottom: 0 }} styles={{ content: { maxHeight: '85dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }, body: { height: 'min(720px, calc(85dvh - 110px))', minHeight: 0, display: 'flex', overflow: 'hidden' } }} title={L('AI 测试', 'AI Testing')}>
    <div className="ai-testing-shell">
      <Alert type="info" message={L('知识库始终开启。批测全局并发1，最多200份回答，结果保留30天。', 'Knowledge is always enabled. Global batch concurrency: 1. Maximum 200 answers per job. Results retained for 30 days.')} />
      <Tabs className="ai-testing-tabs" activeKey={tab} onChange={(key) => { if (busy) return; setTab(key) }} items={[
        { key: 'single', label: L('单题对比', 'Tutor comparison'), children: <TutorComparison key={`${owner}:${courseId}`} initial={{ courseId: courseId ?? '', releaseId: current?.releaseId ?? '', model: current?.model ?? models[0] ?? '', runningSolution: 'dialogue-yong', modes: ['LECTURE'], kind: 'multi' }} models={models} releases={releases} en={en} /> },
        { key: 'batch', label: L('Excel 批量测试', 'Excel batch test'), children: <div className="ai-batch-pane">
          <div className="ai-batch-config">
        <Select title={config.model} aria-label={L('模型', 'Model')} disabled={locked} value={config.model} onChange={(model) => patch({ model })} options={models.map((value) => ({ value, label: value.split('/').at(-1) }))}  />
        <Select
          title={releases.find((r) => r.id === config.releaseId)?.versionTag}
          aria-label={L('知识库版本', 'Knowledge release')}
          disabled={locked}
          value={config.releaseId}
          onChange={(releaseId) => patch({ releaseId })}
          options={releases.map((release) => ({ value: release.id, label: release.versionTag, release }))}
          optionRender={({ data }) => <AiReleaseOption release={data.release} />}
          popupMatchSelectWidth={280}
          virtual={false}
        />
        <Select aria-label={L('对话模式', 'Mode')} disabled={locked} value={config.modes[0]} onChange={(mode) => { setConfig((c) => ({ ...c, modes: [mode] })); submissionKey.current = crypto.randomUUID() }} options={[{value:'LECTURE',label:'Lecture'},{value:'SOCRATIC',label:'Socratic'}]} />
      </div>

          <Space>{(['LECTURE', 'SOCRATIC'] as const).map((mode) => <a key={mode} href={`/api${root}/template?mode=${mode}`}>{mode === 'LECTURE' ? L('下载讲授示例', 'Download Lecture example') : L('下载苏格拉底示例', 'Download Socratic example')}</a>)}</Space>
          <input aria-label={L('上传Excel', 'Upload Excel')} type="file" accept=".xlsx" disabled={busy} onChange={(e) => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = '' }} />
          {errors.length > 0 && <Alert type="error" message={evaluationText(errors.join('; '),en)} />}
          <div>{L('有效问题 / 预计回答数：', 'Questions / planned answers: ')}{questions.length} / {questions.length * config.modes.length}</div>
          <div className="ai-test-scroll ai-question-preview">{questions.map((q) => <div key={`${q.conversationId}:${q.turn}`}>{q.conversationId} · {q.turn} · {q.question}</div>)}</div>
          <Button disabled={busy || !questions.length || errors.length > 0 || questions.length * config.modes.length > 200 || !config.releaseId || !config.model} onClick={() => modal.confirm({ title: L('开始批量测试？', 'Start batch test?'), content: `${questions.length * config.modes.length} ${L('份回答，将产生模型调用费用。', 'answers. Model usage will be charged.')}`, onOk: async () => { try { const response = await http.post<Task>(`${root}/tasks`, { config, questions, source, submissionKey: submissionKey.current }); selectTask(response.data); setTab('tasks') } catch (e) { message.error(evaluationText((e as Error).message, en)); throw e } } })}>{L('开始测试', 'Start test')}</Button>
        </div> },
        { key: 'tasks', label: L('任务记录', 'Task history'), children: <div className="ai-task-pane">
          {taskRefreshFailed && <Alert
            type="warning"
            showIcon
            message={L('暂时无法刷新任务记录。', 'Task history could not be refreshed.')}
            action={<Button size="small" onClick={refreshTaskHistory}>{L('重试', 'Retry')}</Button>}
          />}
          <div className="ai-task-list ai-test-scroll">{tasks.map((task) => <Button key={task.id} onClick={() => void loadTask(task.id)}>{task.name && <span className="ai-task-name" title={task.name}>{task.name} · </span>}{task.createdAt.slice(0, 19)} · {task.config.model} · {L(({ queued: '排队中', running: '运行中', stopping: '停止中', stopped: '已停止', completed: '已结束' } as Record<string, string>)[task.status] ?? task.status, task.status)}</Button>)}
          </div>
          {selected && <>
            <Space wrap>
              <span className="ai-task-name">{selected.name || selected.id}</span>
              <span>{L('成功', 'Success')} {successful}/{selected.results.length} · {L('失败', 'Failed')} {selected.results.filter((r) => r.status === 'failed').length}</span>
              {canEdit && <Button size="small" onClick={() => setRename({ id: selected.id, name: selected.name ?? '' })}>{L('重命名', 'Rename')}</Button>}
            </Space>
            <div>{selected.config.runningSolution} · {selected.config.modes.join(' / ')} · {L('已提交', 'Submitted')} {Math.max(0, Math.floor((Date.now() - Date.parse(selected.createdAt)) / 60000))} {L('分钟', 'minutes ago')}</div>
            <progress value={selected.status === 'stopped' ? successful : selectedDone} max={selected.results.length} style={{ width: '100%' }} />
            <div>{selected.status === 'running' ? estimate === null ? L('预计时间：估算中', 'ETA: estimating') : L(`预计剩余约${estimate}分钟（不含排队等待）`, `About ${estimate} minutes remaining (excluding queue delays)`) : ''}</div>
            <Space wrap>
              {['queued', 'running'].includes(selected.status) && <Button danger onClick={() => void action(`${root}/tasks/${selected.id}/stop`)}>{L('停止测试', 'Stop test')}</Button>}
              {['stopped', 'completed'].includes(selected.status) && <><Button onClick={() => modal.confirm({ title: L('从头重新生成全部答案？', 'Regenerate all answers from the beginning?'), content: L('创建新任务，会重新产生模型调用费用。', 'Creates a new job and incurs model usage costs again.'), onOk: () => action(`${root}/tasks/${selected.id}/restart`) })}>{L('重新开始', 'Restart')}</Button><Button danger onClick={() => modal.confirm({ title: L('删除题目、结果和文件？', 'Delete questions, results and files?'), onOk: () => action(`${root}/tasks/${selected.id}`, 'delete') })}>{L('删除任务', 'Delete job')}</Button></>}
              <Button onClick={() => void action(`${root}/tasks/${selected.id}/source`, 'delete')}>{L('删除上传Excel', 'Delete uploaded Excel')}</Button>
              <Button href={`/api${root}/tasks/${selected.id}/export?locale=${locale}`}>{L('下载结果 Excel', 'Download results Excel')}</Button>
              <Button href={`/api${root}/tasks/${selected.id}/export?format=json`}>{L('下载数据', 'Download JSON')}</Button>
            </Space>
            <div className="ai-test-scroll ai-task-results">{selected.results.map((r, i) => <details key={i}><summary>{r.conversationId} · {r.turn} · {r.mode} · {evaluationText(r.status,en)} · {r.question}</summary><div>{evaluationText(r.error ?? '',en)}</div><TutorMarkdown jackLecture={selected.config.runningSolution === 'grounded-jack' && r.mode === 'LECTURE'} content={r.answer} courseId={selected.config.courseId} sourcesLabel={L('来源', 'Sources')} /></details>)}</div>
          </>}
        </div> },
      ]} />
    </div>
    <Modal
      open={open && rename !== null}
      title={L('重命名任务', 'Rename task')}
      okText={L('保存', 'Save')}
      cancelText={L('取消', 'Cancel')}
      confirmLoading={renaming}
      okButtonProps={{ disabled: !rename?.name.trim() }}
      onOk={() => void renameTask()}
      onCancel={() => { if (!renaming) setRename(null) }}
    >
      <Input
        aria-label={L('任务名称', 'Task name')}
        value={rename?.name ?? ''}
        maxLength={80}
        disabled={renaming}
        onChange={(event) => setRename((currentRename) => currentRename && { ...currentRename, name: event.target.value })}
        onPressEnter={() => void renameTask()}
      />
    </Modal>
  </Modal>
}
