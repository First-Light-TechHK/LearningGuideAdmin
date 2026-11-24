import './support/dom'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { CourseDetail } from '../src/backoffice/contracts/course'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { CourseEditorPage } from '../src/backoffice/pages/CourseEditorPage'
import { employee, installFakeServer, type FakeServer } from './support/helpdesk-fake'

// LOW-3 (verify-takeover-20261116): the editor Basics used to keep its own required-field
// rule, so it could show Incomplete while the completeness API said
// courseInformation.complete = true / canPublish = true. The fixtures below are real
// GET /api/backoffice/courses/:id responses captured on 2026-11-20 from a fresh database
// (branch fix/learning-point-identity): one fully complete bilingual course, one
// single-language en-GB course. The UI must copy the server's verdict, never re-derive it.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const complete = JSON.parse(read('./fixtures/course-completeness-low3.detail.json')) as CourseDetail
const incomplete = JSON.parse(read('./fixtures/course-completeness-low3-incomplete.detail.json')) as CourseDetail

afterEach(cleanup)

function renderEditor(detail: CourseDetail): FakeServer {
  const server = installFakeServer()
  const id = detail.id
  server.on('GET', `/api/backoffice/courses/${id}`, { data: detail })
  server.on('GET', `/api/backoffice/courses/${id}/trial`, {
    data: { enabled: false, learningMode: detail.learningMode, learningLanguages: detail.learningLanguages, rows: [] },
  })
  server.on('GET', `/api/backoffice/courses/${id}/versions`, { data: [] })
  server.on('GET', `/api/backoffice/courses/${id}/history`, { data: { items: [], total: 0, page: 1, pages: 1 } })
  server.on('GET', '/api/backoffice/courses/categories', { data: [] })
  render(
    <MemoryRouter initialEntries={[`/en-GB/course/${id}`]}>
      <EmployeeContext.Provider value={employee('ADMIN')}>
        <Routes>
          <Route path="/:locale/course/:courseId" element={<CourseEditorPage />} />
        </Routes>
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
  return server
}

function basics(detail: CourseDetail) {
  const tab = screen.getByRole('button', { name: /Course Information/ })
  return {
    chip: screen.getByTestId('info-complete').textContent?.trim(),
    // 新布局把完成标记放在 tab 内的 .course-ui-tabMark 上（aria-label/title）；
    // 断言意图不变：标记必须反映服务端的 complete 判定。
    tab: tab.querySelector('.course-ui-tabMark')?.getAttribute('aria-label')?.trim(),
    step: detail.completeness.steps.courseInformation.complete,
  }
}

test('Basics shows the server verdict when the API says Course Information is complete', async () => {
  const server = renderEditor(complete)
  try {
    await screen.findByTestId('info-complete')
    const shown = basics(complete)
    assert.equal(complete.completeness.steps.courseInformation.complete, true)
    assert.equal(complete.completeness.canPublish, true)
    assert.equal(shown.chip, 'Complete')
    assert.ok(shown.tab?.endsWith('Complete'), `step label: ${shown.tab}`)
  } finally {
    server.restore()
  }
})

test('Basics does not keep its own required rules: a single-language payload the server calls complete shows Complete', async () => {
  // The old chip required a Chinese title and a fully bilingual learn/provides list on its
  // own. This fixture is that shape (only English filled) while the server still says
  // complete = true; the page must follow the server (LOW-3).
  const single: CourseDetail = structuredClone(complete)
  single.learningLanguages = ['en-GB']
  single.localizations = single.localizations
    .filter((row) => row.language === 'en-GB')
    .map((row) => ({ ...row, title: 'Single language course' }))
  single.completeness.steps.courseInformation = { complete: true, missing: [] }
  single.completeness.issues = []
  const server = renderEditor(single)
  try {
    await screen.findByTestId('info-complete')
    assert.equal(basics(single).chip, 'Complete')
    assert.equal(screen.queryAllByTestId('field-issue').length, 0)
  } finally {
    server.restore()
  }
})

test('Basics shows Incomplete and places the server issues when the API says it is incomplete', async () => {
  const server = renderEditor(incomplete)
  try {
    await screen.findByTestId('info-complete')
    const shown = basics(incomplete)
    assert.equal(incomplete.completeness.steps.courseInformation.complete, false)
    assert.equal(shown.chip, 'Incomplete')
    assert.ok(shown.tab?.endsWith('Incomplete'), `step label: ${shown.tab}`)
    const issues = screen.getAllByTestId('field-issue').map((node) => node.textContent?.trim())
    assert.ok(issues.length > 0)
    assert.ok(issues.includes('Required'))
  } finally {
    server.restore()
  }
})
