import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { emptyFeedbackFilters, feedbackSource, filterFeedback } from '../src/api/feedback'
import { AITutorFeedback } from '../src/pages/AITutorFeedback'
import { AITutorTopBar } from '../src/pages/AITutor'
import { App as AntApp } from 'antd'
import { AITutorWorkspace } from '../src/pages/AITutorWorkspace'
import { ShellRoute } from '../src/backoffice/ShellRoute'
import { WorkspaceAccessProvider } from '../src/backoffice/lib/workspaceAccess'
import { useAiStore } from '../src/stores/aiStore'
import { employee, installFakeServer } from './support/helpdesk-fake'

afterEach(cleanup)
const filter = (patch: Partial<typeof emptyFeedbackFilters>) => filterFeedback(feedbackSource.list(), { ...emptyFeedbackFilters, ...patch })

test('filters combine course, reporter type, mode and status without changing source records', () => {
  assert.deepEqual(filter({ courseId: 'demo-modelling', type: 'Student', status: 'New', mode: 'LECTURE' }).map((r) => r.id), ['DEMO-002'])
  assert.equal(filter({ courseId: 'demo-history', type: 'Student' }).length, 0)
  const changed = feedbackSource.list()
  changed[0].feedback = 'edited'
  assert.notEqual(feedbackSource.list()[0].feedback, 'edited')
})

test('search covers original question, answer, suggested answer, reporter and feedback', () => {
  for (const [search, expected] of [[' SHARK ', 'DEMO-001'], ['initial condition', 'DEMO-005'], ['Compare', 'DEMO-006'], ['not-present', 'none'], ['Student Demo 1842', 'DEMO-002'], ['compatible units', 'DEMO-006'], ['Inspect the two components', 'DEMO-001']]) {
    const ids = filter({ search }).map((r) => r.id)
    assert.ok(expected === 'none' ? ids.length === 0 : ids.includes(expected), search)
  }
  assert.equal(filter({ search: '  ' }).length, 6)
})

test('rolling date window includes cutoff, excludes future, invalid dates and older records', () => {
  const now = Date.parse('2026-11-09T06:32:00Z')
  const record = feedbackSource.list()[0]
  const rows = [record, { ...record, id: 'old', submittedAt: '2026-11-02T06:31:59Z' },
    { ...record, id: 'future', submittedAt: '2026-11-09T06:32:01Z' }, { ...record, id: 'invalid', submittedAt: '' }]
  assert.deepEqual(filterFeedback(rows, { ...emptyFeedbackFilters, days: 7 }, now).map((r) => r.id), ['DEMO-001'])
  assert.equal(filter({ days: 0 }).length, 6)
})

function openPage(locale = 'en-GB') {
  return render(<MemoryRouter initialEntries={[`/${locale}/ai-tutor`]}><Routes><Route path="/:locale/ai-tutor" element={<AITutorFeedback />} /></Routes></MemoryRouter>)
}

test('page paginates, resets page on search, shows empty state and restores records', () => {
  openPage()
  assert.ok(screen.getByText('Sample data. Portal feedback is not connected.'))
  assert.equal(screen.queryByText('DEMO-006'), null)
  fireEvent.click(screen.getByTitle('2'))
  assert.ok(screen.getByText('DEMO-006'))
  const search = screen.getByRole('textbox', { name: 'Search question, answer, user or feedback' })
  fireEvent.change(search, { target: { value: 'DEMO-002' } })
  assert.ok(screen.getByText('DEMO-002'))
  assert.ok(screen.getByText('Feedback records (1)'))
  fireEvent.change(search, { target: { value: 'does-not-exist' } })
  assert.ok(screen.getByText('No feedback matches these filters.'))
  fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])
  assert.ok(screen.getByText('Feedback records (6)'))
  assert.ok(screen.getByText('DEMO-001'))
})

test('Chinese UI and tab selection use existing locale and labelled controls', () => {
  openPage('zh-CN')
  assert.ok(screen.getByRole('heading', { name: '反馈中心' }))
  assert.ok(screen.getByRole('combobox', { name: '课程' }))
  assert.ok(screen.getAllByText('Modelling Life').length > 0)
  cleanup()
  let selected = ''
  render(<MemoryRouter><AITutorTopBar active="feedback" onChange={(tab) => { selected = tab }} /></MemoryRouter>)
  assert.equal(screen.getByRole('tab', { name: 'Feedback' }).getAttribute('aria-selected'), 'true')
  fireEvent.click(screen.getByRole('tab', { name: 'AI Tutor' }))
  assert.equal(selected, 'tutor')
})

test('course, type and status selectors combine in the rendered list', () => {
  openPage()
  for (const [name, label] of [['Course', 'Modelling Life'], ['Type', 'Student'], ['Status', 'New']]) {
    fireEvent.mouseDown(screen.getByRole('combobox', { name }))
    fireEvent.click(screen.getByText(label, { selector: '.ant-select-item-option-content' }))
  }
  assert.ok(screen.getByText('Feedback records (1)'))
  assert.ok(screen.getByText('DEMO-002'))
})

test('workspace tab switch preserves Tutor state and Feedback filters without reinitializing or cancelling', async () => {
  const initial = useAiStore.getState()
  const server = installFakeServer()
  server.on('GET', '/api/session', { data: { employee: employee('ADMIN') } })
  let initCalls = 0, cancelCalls = 0
  useAiStore.setState({ init: async (ownerId) => { initCalls++; useAiStore.setState({ ownerId }) }, cancel: () => { cancelCalls++ } })
  try {
    render(<AntApp><MemoryRouter initialEntries={['/en-GB/ai-tutor']}><Routes><Route path="/:locale" element={<ShellRoute />}><Route path="ai-tutor" element={<WorkspaceAccessProvider menu="aiTutor"><AITutorWorkspace /></WorkspaceAccessProvider>} /></Route></Routes></MemoryRouter></AntApp>)
    await waitFor(() => assert.equal(initCalls, 1))
    act(() => useAiStore.setState({ form: { ...initial.form, systemPrompt: 'unsaved draft' }, messages: [{ role: 'user', content: 'keep my chat', createdAt: '2026-11-13T00:00:00Z' }] }))
    fireEvent.click(screen.getByRole('tab', { name: 'Feedback' }))
    assert.ok(screen.getByRole('heading', { name: 'Feedback Centre' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search question, answer, user or feedback' }), { target: { value: 'DEMO-002' } })
    fireEvent.click(screen.getByRole('tab', { name: 'AI Tutor' }))
    assert.equal(useAiStore.getState().form.systemPrompt, 'unsaved draft')
    assert.equal(useAiStore.getState().messages[0].content, 'keep my chat')
    assert.equal(initCalls, 1)
    assert.equal(cancelCalls, 0)
    fireEvent.click(screen.getByRole('tab', { name: 'Feedback' }))
    assert.ok(screen.getByText('Feedback records (1)'))
    assert.ok(screen.getByText('DEMO-002'))
  } finally {
    cleanup()
    server.restore()
    useAiStore.setState(initial, true)
    localStorage.clear()
  }
})

test('details expose original answer and suggestions read-only and close without losing search', async () => {
  openPage()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search question, answer, user or feedback' }), { target: { value: 'DEMO-001' } })
  fireEvent.click(screen.getByRole('button', { name: 'DEMO-001' }))
  const dialog = await screen.findByRole('dialog')
  assert.ok(dialog.textContent?.includes(feedbackSource.list()[0].answer))
  assert.ok(dialog.textContent?.includes(feedbackSource.list()[0].context!))
  assert.ok(dialog.textContent?.includes('Teaching Sequence'))
  assert.ok(dialog.textContent?.includes(feedbackSource.list()[0].suggestedAnswer!))
  assert.ok(dialog.textContent?.includes('Runtime trace was not captured'))
  assert.equal(dialog.querySelectorAll('input,textarea,select').length, 0)
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
  assert.ok(screen.getByText('Feedback records (1)'))
})

test('student details show missing fields rather than invented content', async () => {
  openPage()
  fireEvent.click(screen.getByRole('button', { name: 'DEMO-002' }))
  const dialog = await screen.findByRole('dialog')
  assert.ok(dialog.textContent?.includes(feedbackSource.list()[1].question))
  assert.ok(dialog.textContent?.includes(feedbackSource.list()[1].answer))
  assert.ok(dialog.textContent?.includes('Not captured.'))
  assert.ok(dialog.textContent?.includes('Not provided.'))
  assert.equal(dialog.querySelectorAll('input,textarea,select').length, 0)
})
