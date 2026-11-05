import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Lesson } from '../src/backoffice/contracts/course'
import type { StudentList } from '../src/backoffice/contracts/students'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { UnderstandingPanel } from '../src/backoffice/pages/course-editor/UnderstandingPanel'
import { StudentManagementPage } from '../src/backoffice/pages/StudentManagementPage'
import { MarkdownToolbar } from '../src/components/knowledge/MarkdownToolbar'
import { deferred, employee, installFakeServer, type Reply } from './support/helpdesk-fake'

afterEach(cleanup)

function lesson(id: string): Lesson {
  return {
    id, code: id, sortOrder: 1, localizations: [], exhibits: [], readings: [],
    questions: [{ code: 'K-0001', question: `Question ${id}`, referenceAnswer: `Answer ${id}` }],
    applicationTest: { scenario: `Scenario ${id}`, referenceAnswer: `Application ${id}` },
    learningPoints: [],
  }
}

test('understanding drafts survive parent renders and reset on lesson/language changes', () => {
  const first = lesson('one')
  const props = {
    locale: 'en-GB', courseId: 'course', lesson: first, language: 'en-GB', busy: false,
    setBusy: () => {}, onSaved: () => Promise.resolve(), onNotice: () => {},
  }
  const view = render(<UnderstandingPanel {...props} />)
  fireEvent.change(screen.getByDisplayValue('Question one'), { target: { value: 'Unsaved draft' } })
  view.rerender(<UnderstandingPanel {...props} busy />)
  assert.ok(screen.getByDisplayValue('Unsaved draft'))
  view.rerender(<UnderstandingPanel {...props} language="zh-CN" />)
  assert.ok(screen.getByDisplayValue('Question one'))
  view.rerender(<UnderstandingPanel {...props} lesson={lesson('two')} />)
  assert.ok(screen.getByDisplayValue('Question two'))
  assert.ok(screen.getByDisplayValue('Scenario two'))
  assert.equal(screen.queryByDisplayValue('Question one'), null)
})

test('Markdown toolbar subscribes to the current editor and detaches the previous one', () => {
  const editor = {
    dom: document.createElement('div'),
    state: EditorState.create({ doc: '# First\n## Second', selection: { anchor: 3 } }),
  } as EditorView
  const view = render(<MemoryRouter><MarkdownToolbar view={editor} /></MemoryRouter>)
  const h1 = screen.getByRole('button', { name: 'H1' })
  assert.ok(h1.classList.contains('ant-btn-primary'))
  act(() => {
    editor.state = editor.state.update({ selection: { anchor: 12 } }).state
    fireEvent.keyUp(editor.dom)
  })
  assert.ok(screen.getByRole('button', { name: 'H2' }).classList.contains('ant-btn-primary'))
  assert.ok(!screen.getByRole('button', { name: 'H1' }).classList.contains('ant-btn-primary'))
  view.rerender(<MemoryRouter><MarkdownToolbar view={null} /></MemoryRouter>)
  act(() => fireEvent.keyUp(editor.dom))
  assert.ok((screen.getByRole('button', { name: 'H1' }) as HTMLButtonElement).disabled)
})

function studentPage(name: string, page: number): StudentList {
  return {
    items: [{
      id: name, name, email: `${name}@example.com`, accountStatus: 'active',
      emailVerification: 'verified', subscription: { count: 0, label: null, state: null },
      specialAccess: [], registeredAt: '2026-01-01T00:00:00Z',
    }],
    page, pageSize: 10, total: 20, counts: { total: 20, active: 20, inactive: 0 },
  }
}

test('student pagination keeps previous rows and ignores an older page response', async () => {
  const server = installFakeServer()
  const slow = deferred<Reply>()
  try {
    window.localStorage.clear()
    server.on('GET', '/api/students', (call) => call.query.get('page') === '2'
      ? slow.promise : { data: studentPage('First student', 1) })
    render(
      <MemoryRouter initialEntries={['/en-GB/student']}>
        <EmployeeContext.Provider value={employee('ADMIN')}>
          <Routes><Route path="/:locale/student" element={<StudentManagementPage />} /></Routes>
        </EmployeeContext.Provider>
      </MemoryRouter>,
    )
    await screen.findByText('First student')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => assert.equal(server.callsTo('GET', '/api/students').length, 2))
    assert.ok(screen.getByText('First student'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText('First student')
    await act(async () => { slow.resolve({ data: studentPage('Stale student', 2) }) })
    assert.equal(screen.queryByText('Stale student'), null)
    assert.ok(screen.getByText('First student'))
  } finally {
    server.restore()
  }
})
