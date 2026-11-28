import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test, type TestContext } from 'node:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App, ConfigProvider } from 'antd'
import { EvaluationPanel } from '../src/components/ai/EvaluationPanel'
import { useAiStore } from '../src/stores/aiStore'
import { http } from '../src/api/client'
import type { AiConfigView } from '../src/api/ai'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'

const initial = useAiStore.getState(), originalGet = http.get, originalPatch = http.patch, originalPost = http.post
afterEach(() => { cleanup(); useAiStore.setState(initial, true); http.get = originalGet; http.patch = originalPatch; http.post = originalPost })

function renderPanel(locale = 'en-GB') {
  render(<App><ConfigProvider theme={{ token: { motion: false } }}><MemoryRouter initialEntries={[`/${locale}`]}><Routes><Route path="/:locale" element={
    <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'aiTutor')}>
      <EvaluationPanel open close={() => undefined} />
    </WorkspaceAccessContext.Provider>
  } /></Routes></MemoryRouter></ConfigProvider></App>)
}

for (const locale of ['zh-CN', 'en-GB']) {
  test(`evaluation has bilingual templates and keeps the normal chat untouched (${locale})`, async () => {
    const messages = [{ role: 'user' as const, content: 'keep chat', createdAt: 'now' }]
    useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: { releaseId: 'r1', model: 'm1' } as AiConfigView, models: ['m1'], releases: [{ id: 'r1', versionTag: 'v1' } as never], messages })
    http.get = (async () => ({ data: [] })) as unknown as typeof http.get
    renderPanel(locale)
    fireEvent.click(await screen.findByRole('tab', { name: locale === 'zh-CN' ? 'Excel 批量测试' : 'Excel batch test' }))
    const blank = screen.getByRole('link', { name: locale === 'zh-CN' ? '下载讲授示例' : 'Download Lecture example' })
    assert.ok(blank.getAttribute('href')?.includes('mode=LECTURE'))
    assert.equal(screen.queryByRole('link', { name: /空白|blank/i }), null)
    assert.equal(screen.queryByRole('combobox', { name: /回答语言|Answer language/ }), null)
    assert.equal((screen.getByRole('button', { name: locale === 'zh-CN' ? '开始测试' : 'Start test' }) as HTMLButtonElement).disabled, true)
    assert.equal(useAiStore.getState().messages, messages)
    assert.equal(screen.queryByText(locale === 'zh-CN' ? '使用知识库' : 'Use knowledge'), null)
  })
}

const tasksUrl = '/ai/evaluation/tasks'
const task = (id: string, status: string) => ({
  id, status, createdAt: '2026-11-23T10:00:00Z', results: [],
  config: { courseId: 'c1', model: id, runningSolution: 'grounded-jack', modes: ['LECTURE'] },
})

function renderHistoryTest(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  renderPanel()
}

async function clickTab(name: string) {
  await act(async () => fireEvent.click(screen.getByRole('tab', { name })))
}

async function poll(t: TestContext) {
  await act(async () => t.mock.timers.tick(3000))
}

test('double-clicking restart opens one confirmation and submits one keyed request', async () => {
  const completed = task('job-1', 'completed')
  http.get = (async (url: string) => ({ data: url === tasksUrl ? [completed] : completed })) as typeof http.get
  const keys: string[] = []
  let finish!: (result: { data: ReturnType<typeof task> }) => void
  http.post = ((url: string, body: { submissionKey: string }) => {
    assert.equal(url, tasksUrl + '/job-1/restart')
    keys.push(body.submissionKey)
    return new Promise((resolve) => { finish = resolve })
  }) as typeof http.post
  renderPanel()
  await clickTab('Task history')
  fireEvent.click(await screen.findByRole('button', { name: /job-1 · completed/ }))
  const restart = await screen.findByRole('button', { name: 'Restart' })
  act(() => { fireEvent.click(restart); fireEvent.click(restart) })
  const heading = 'Regenerate all answers from the beginning?'
  const dialog = await screen.findByRole('dialog', { name: heading })
  assert.equal(screen.getAllByRole('dialog', { name: heading }).length, 1)
  const confirm = within(dialog).getByRole('button', { name: 'OK' })
  act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
  assert.equal(keys.length, 1)
  assert.match(keys[0], /^[\da-f-]{36}$/i)
  await act(async () => finish({ data: task('job-2', 'queued') }))
})

test('only loads task history when that tab is opened and stops scheduling after the last active job ends', async (t) => {
  const statuses = ['queued', 'running', 'stopping', 'completed']
  let calls = 0
  http.get = (async () => ({ data: [task('job-1', statuses[calls++])] })) as unknown as typeof http.get
  renderHistoryTest(t)
  await poll(t)
  await clickTab('Excel batch test')
  await poll(t)
  assert.equal(calls, 0)

  await clickTab('Task history')
  assert.equal(calls, 1)
  for (const status of statuses.slice(1)) {
    await poll(t)
    assert.ok(screen.getByRole('button', { name: new RegExp(`job-1 · ${status}`) }))
  }
  await poll(t)
  assert.equal(calls, 4)
})

test('leaving task history aborts the current refresh and ignores its response', async (t) => {
  let signal: AbortSignal | undefined
  let finish!: (result: { data: ReturnType<typeof task>[] }) => void
  const pending = new Promise<{ data: ReturnType<typeof task>[] }>((resolve) => { finish = resolve })
  let calls = 0
  http.get = ((_url: string, options: { signal: AbortSignal }) => {
    calls++
    signal = options.signal
    return pending
  }) as unknown as typeof http.get
  renderHistoryTest(t)
  await clickTab('Task history')
  await clickTab('Tutor comparison')
  assert.equal(signal?.aborted, true)

  await act(async () => finish({ data: [task('job-1', 'running')] }))
  await poll(t)
  assert.equal(calls, 1)
})

test('keeps visible tasks during failures and shows a page warning only after consecutive failures', async (t) => {
  let calls = 0
  http.get = (async () => {
    calls++
    if (calls === 2 || calls === 3) throw new Error('Temporary error')
    return { data: [task('job-1', calls === 1 ? 'running' : 'completed')] }
  }) as unknown as typeof http.get
  renderHistoryTest(t)
  await clickTab('Task history')
  await poll(t)
  assert.equal(screen.queryByText('Task history could not be refreshed.'), null)

  await poll(t)
  assert.ok(screen.getByText('Task history could not be refreshed.'))
  assert.ok(screen.getByRole('button', { name: /job-1 · running/ }))
  assert.equal(screen.queryByText('Temporary error'), null)

  await poll(t)
  assert.equal(screen.queryByText('Task history could not be refreshed.'), null)
  assert.ok(screen.getByRole('button', { name: /job-1 · completed/ }))
})

test('stops after a failed initial load and one retry, and lets the user reload the history', async (t) => {
  let calls = 0
  http.get = (async () => {
    if (++calls <= 2) throw new Error('Temporary error')
    return { data: [task('job-1', 'completed')] }
  }) as unknown as typeof http.get
  renderHistoryTest(t)
  await clickTab('Task history')
  await poll(t)
  await poll(t)
  assert.equal(calls, 2)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  assert.equal(screen.queryByText('Task history could not be refreshed.'), null)
  assert.ok(screen.getByRole('button', { name: /job-1 · completed/ }))
  await poll(t)
  assert.equal(calls, 3)
})

test('clears selection on a missing task and keeps following other active jobs', async (t) => {
  const first = task('job-1', 'running')
  let listCalls = 0
  let detailCalls = 0
  http.get = (async (url: string) => {
    if (url === tasksUrl) {
      listCalls++
      return { data: listCalls === 1 ? [first] : [task('job-2', listCalls === 2 ? 'running' : 'completed')] }
    }
    assert.equal(url, `${tasksUrl}/job-1`)
    if (++detailCalls === 1) return { data: first }
    throw Object.assign(new Error('Task missing'), { code: 'NOT_FOUND' })
  }) as unknown as typeof http.get
  renderHistoryTest(t)
  await clickTab('Task history')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /job-1 · running/ })))
  assert.ok(screen.getByRole('progressbar'))

  await poll(t)
  assert.equal(screen.queryByRole('progressbar'), null)
  assert.equal(screen.queryByText('Task missing'), null)

  await poll(t)
  assert.equal(detailCalls, 2)
  assert.equal(listCalls, 3)
  assert.ok(screen.getByRole('button', { name: /job-2 · completed/ }))
})

test('renames an existing task in history and preserves the new name across an older poll', async (t) => {
  const running = task('job-1', 'running')
  let current: typeof running & { name?: string } = running
  let finishStaleList!: (result: { data: typeof running[] }) => void
  const staleList = new Promise<{ data: typeof running[] }>((resolve) => { finishStaleList = resolve })
  let listCalls = 0
  http.get = (async (url: string) => {
    if (url === `${tasksUrl}/job-1`) return { data: current }
    if (++listCalls === 2) return staleList
    return { data: [current] }
  }) as unknown as typeof http.get
  const newName = 'Modeling life · 第 1 课回归'
  http.patch = (async (url: string, body: { name: string }) => {
    assert.equal(url, `${tasksUrl}/job-1/name`)
    assert.deepEqual(body, { name: newName })
    current = { ...current, name: body.name }
    return { data: { id: current.id, name: current.name } }
  }) as unknown as typeof http.patch

  renderHistoryTest(t)
  await clickTab('Task history')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /job-1 · running/ })))
  assert.ok(screen.getByText('job-1', { exact: true }))
  await poll(t)
  assert.equal(listCalls, 2)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rename' })))
  const dialog = within(screen.getByRole('dialog', { name: 'Rename task' }))
  assert.equal((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled, true)
  fireEvent.change(dialog.getByRole('textbox', { name: 'Task name' }), { target: { value: `  ${newName}  ` } })
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Save' })))
  await act(async () => finishStaleList({ data: [running] }))
  assert.equal(screen.queryByText('job-1', { exact: true }), null)
  assert.ok(screen.getByText(newName, { exact: true }))
  assert.ok(screen.getByRole('button', { name: /第 1 课回归.*job-1 · running/ }))

  const excel = screen.getByRole('link', { name: 'Download results Excel' })
  const json = screen.getByRole('link', { name: 'Download JSON' })
  assert.ok(excel.classList.contains('ant-btn') && json.classList.contains('ant-btn'))
  assert.equal(excel.getAttribute('href'), `/api${tasksUrl}/job-1/export?locale=en-GB`)
  assert.equal(json.getAttribute('href'), `/api${tasksUrl}/job-1/export?format=json`)
})

test('shows release notes and the Live badge in the batch selector and keeps its choice local', async () => {
  const config = { releaseId: 'r1', model: 'm1' } as AiConfigView
  const release = { createdAt: '', isActive: false, isEditing: false, isTestSelected: false }
  useAiStore.setState({
    selectedCourseId: 'c1', config, models: ['m1'], releases: [
      { ...release, id: 'r1', versionTag: 'Release 1', revisionNotes: 'Changed formulas', isActive: true },
      { ...release, id: 'r2', versionTag: 'Release 2', revisionNotes: '' },
    ],
  })
  renderPanel()
  await clickTab('Excel batch test')
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Knowledge release' }))
  const first = await screen.findByRole('option', { name: /Release 1/ })
  assert.ok(within(first).getByText('Changed formulas'))
  assert.ok(within(first).getByText('Live'))
  const second = screen.getByRole('option', { name: /Release 2/ })
  assert.ok(within(second).getByText('No version notes'))
  fireEvent.click(second)
  assert.equal(useAiStore.getState().config?.releaseId, 'r1')
  const selector = screen.getByRole('combobox', { name: 'Knowledge release' }).closest('.ant-select')!
  assert.ok(within(selector).getByText('Release 2', { exact: true }))
})
