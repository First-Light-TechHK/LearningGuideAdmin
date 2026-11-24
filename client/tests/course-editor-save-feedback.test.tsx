import './support/dom'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { CourseDetail } from '../src/backoffice/contracts/course'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { CourseEditorPage } from '../src/backoffice/pages/CourseEditorPage'
import { employee, installFakeServer, type FakeServer } from './support/helpdesk-fake'

// 保存反馈：成功/失败必须出现在"保存"按钮旁（页面底部），
// 未完成的步骤要能说明缺什么（页签 title + 缺项数），不能只在页面顶部提示。
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const detail = JSON.parse(read('./fixtures/course-completeness-low3.detail.json')) as CourseDetail
const lesson = detail.lessons[0]
const base = `/api/backoffice/courses/${detail.id}`

afterEach(cleanup)

function renderEditor(data: CourseDetail): FakeServer {
  const server = installFakeServer()
  server.on('GET', base, { data })
  server.on('GET', `${base}/trial`, { data: { enabled: false, learningMode: data.learningMode, learningLanguages: data.learningLanguages, rows: [] } })
  server.on('GET', `${base}/versions`, { data: [] })
  server.on('GET', `${base}/history`, { data: { items: [], total: 0, page: 1, pages: 1 } })
  server.on('GET', '/api/backoffice/courses/categories', { data: [] })
  render(
    <MemoryRouter initialEntries={[`/en-GB/course/${detail.id}`]}>
      <EmployeeContext.Provider value={employee('ADMIN')}>
        <Routes>
          <Route path="/:locale/course/:courseId" element={<CourseEditorPage />} />
        </Routes>
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
  return server
}

async function openContent(): Promise<void> {
  fireEvent.click(await screen.findByTestId('course-tab-content'))
  await screen.findByRole('button', { name: 'Save' })
}

function allowSaves(server: FakeServer, data: CourseDetail): void {
  server.on('PUT', `${base}/lessons/${lesson.id}`, { data })
  server.on('PUT', `${base}/lessons/${lesson.id}/learning-points`, { data: { points: [] } })
  server.on('PUT', `${base}/lessons/${lesson.id}/triggers`, { data: {} })
  server.on('PUT', `${base}/lessons/${lesson.id}/readings`, { data: { readings: [] } })
}

test('保存成功后，结果出现在保存按钮旁并弹出 toast', async () => {
  const server = renderEditor(detail)
  try {
    allowSaves(server, detail)
    await openContent()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const status = await screen.findByTestId('content-save-status')
    assert.equal(status.getAttribute('data-state'), 'saved')
    assert.match(status.textContent ?? '', /Saved \d{2}:\d{2}/)
    const toast = await screen.findByTestId('course-toast')
    assert.equal(toast.getAttribute('role'), 'status')
    assert.match(toast.textContent ?? '', /Study & Exploration saved/)
  } finally {
    server.restore()
  }
})

test('保存失败时，错误显示在保存按钮旁并弹出 alert，不用滚到顶部才能看到', async () => {
  const server = renderEditor(detail)
  try {
    allowSaves(server, detail)
    server.on('PUT', `${base}/lessons/${lesson.id}`, { status: 400, error: 'VALIDATION_ERROR' })
    await openContent()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const status = await screen.findByTestId('content-save-status')
    assert.equal(status.getAttribute('data-state'), 'error')
    assert.match(status.textContent ?? '', /Lesson info could not be saved/)
    const toast = await screen.findByTestId('course-toast')
    assert.equal(toast.getAttribute('role'), 'alert')
    assert.match(toast.textContent ?? '', /Lesson info could not be saved/)
  } finally {
    server.restore()
  }
})

test('未完成的步骤在页签上显示缺项数，title 列出具体缺什么', async () => {
  const withIssues: CourseDetail = structuredClone(detail)
  withIssues.completeness.steps.content.complete = false
  withIssues.completeness.issues = [
    { code: 'CONTENT_LESSON', step: 'COURSE_CONTENT', field: 'videoDurationSeconds', message: 'Lesson L001: video duration is missing (en-GB).' },
  ]
  const server = renderEditor(withIssues)
  try {
    const tab = await screen.findByTestId('course-tab-content')
    assert.equal(tab.getAttribute('data-missing-count'), '1')
    assert.match(tab.getAttribute('title') ?? '', /video duration is missing/)
    assert.equal(screen.getByTestId('course-tab-missing-content').textContent, '1')
  } finally {
    server.restore()
  }
})
