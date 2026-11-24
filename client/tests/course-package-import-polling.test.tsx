// B1：> 200 MB 课程包分块导入 complete 后作业仍在 VALIDATING（阶段 PACKAGE_QUEUED），
// 前端必须继续轮询 GET /import/:jobId 到 AWAITING_CONFIRM / FAILED / CANCELLED：
// 课程列表弹窗在 VALIDATING 不出现确认按钮，失败显示错误并可取消；
// 版本页「导入课程包」必须先轮询到 AWAITING_CONFIRM 再 POST confirm（否则 409）。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { EmployeeContext } from '../src/backoffice/employeeSession'
import type { ApiFailure } from '../src/backoffice/lib/api'
import { rememberAccountFeatures } from '../src/backoffice/lib/capabilities'
import { IMPORT_POLL_INTERVAL_MS } from '../src/backoffice/lib/packageUpload'
import { CourseManagementPage } from '../src/backoffice/pages/CourseManagementPage'
import { CourseVersionsSection } from '../src/backoffice/pages/course-editor/CourseVersionsSection'
import { FailureProvider } from '../src/backoffice/pages/course-editor/feedback'
import { absent, employee, installFakeServer, type FakeServer } from './support/helpdesk-fake'

const VALIDATING_JOB = {
  jobId: 'job-1',
  status: 'VALIDATING',
  stage: 'PACKAGE_QUEUED',
  progress: 88,
  error: null,
  courseId: null,
  package: null,
  conflict: null,
  report: { errors: [], warnings: [] },
}

const AWAITING_JOB = {
  ...VALIDATING_JOB,
  status: 'AWAITING_CONFIRM',
  stage: 'VALIDATING',
  progress: 100,
}

const FAILED_JOB = {
  ...VALIDATING_JOB,
  status: 'FAILED',
  progress: 100,
  error: 'Missing video file lesson-2/video.mp4',
}

const COURSE = {
  id: 'c1',
  code: 'C1',
  hasDraft: true,
  liveStatus: 'ONLINE',
  learningLanguages: ['en-GB'],
  defaultContentLanguage: 'en-GB',
  localizations: [],
  lessons: [],
  completeness: {
    completedSteps: 3,
    canPublish: true,
    publishBlockerCodes: [],
    incompleteLessons: [],
    steps: {
      courseInformation: { complete: true, missing: [] },
      content: { complete: true, missing: [] },
      trial: { complete: true, missing: [] },
    },
  },
} as never

/** 201 MB（> PACKAGE_DIRECT_UPLOAD_BYTES）：走分块会话；底层字节很小，status 只由 server 回包决定。 */
function bigPackageFile(): File {
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'big-course.lgcourse.zip')
  Object.defineProperty(file, 'size', { value: 201 * 1024 * 1024 })
  return file
}

type XhrRequest = { method: string; url: string }
let xhrRequests: XhrRequest[] = []

/** uploadFileWithProgress 走 XMLHttpRequest：每块立即成功，测试只关心编排顺序。 */
function installFakeXhr(): () => void {
  const original = globalThis.XMLHttpRequest
  class FakeXhr {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    status = 200
    statusText = 'OK'
    responseText = JSON.stringify({ success: true, data: { jobId: 'job-1', progress: 100 } })
    timeout = 0
    withCredentials = false
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    ontimeout: (() => void) | null = null
    onabort: (() => void) | null = null
    private method = ''
    private url = ''
    open(method: string, url: string) {
      this.method = method
      this.url = url
    }
    setRequestHeader() {}
    abort() {}
    send() {
      xhrRequests.push({ method: this.method, url: this.url })
      queueMicrotask(() => this.onload?.())
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXhr })
  return () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: original })
  }
}

/** mock 定时器下把 fetch/React 的微任务与 0ms 任务都排干（React scheduler 走 MessageChannel→setTimeout(0)）。 */
async function settle(rounds = 24): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) {
      mock.timers.tick(0)
      await new Promise((resolve) => setImmediate(resolve))
    }
  })
}

/** 走完一个 1.5s 轮询等待。 */
async function nextPoll(): Promise<void> {
  await act(async () => {
    mock.timers.tick(IMPORT_POLL_INTERVAL_MS)
  })
  await settle()
}

let restoreXhr: (() => void) | null = null
let server: FakeServer | null = null

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
  rememberAccountFeatures(null)
  xhrRequests = []
  restoreXhr = installFakeXhr()
})

afterEach(() => {
  cleanup()
  mock.timers.reset()
  restoreXhr?.()
  restoreXhr = null
  server?.restore()
  server = null
  rememberAccountFeatures(null)
})

function fakeServer(): FakeServer {
  server = installFakeServer()
  server.on('GET', '/api/backoffice/courses', {
    data: { courses: [], page: 1, pageSize: 20, pages: 0, total: 0 },
  })
  server.on('GET', '/api/backoffice/courses/categories', { data: [] })
  server.on('POST', '/api/backoffice/courses/import/package/session', {
    data: { jobId: 'job-1', chunkSize: 201 * 1024 * 1024 },
  })
  return server
}

function renderCourseManagement() {
  return render(
    <MemoryRouter initialEntries={['/en-GB/course']}>
      <Routes>
        <Route
          path="/:locale/course"
          element={
            <EmployeeContext.Provider value={employee('ADMIN')}>
              <CourseManagementPage />
            </EmployeeContext.Provider>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

function choosePackageFile(file: File) {
  fireEvent.click(screen.getByRole('button', { name: /^Import/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import course package' }))
  const input = document.querySelector<HTMLInputElement>('input[accept=".zip,.lgcourse.zip"]')
  assert.ok(input, 'package file input should be rendered')
  fireEvent.change(input, { target: { files: [file] } })
}

test('课程列表：分块导入 complete 返回 VALIDATING 时先轮询，AWAITING_CONFIRM 才出现确认按钮', async () => {
  const fake = fakeServer()
  fake.on('POST', '/api/backoffice/courses/import/package/job-1/complete', { data: VALIDATING_JOB })
  fake.on('GET', '/api/backoffice/courses/import/job-1', { data: AWAITING_JOB })
  fake.on('POST', '/api/backoffice/courses/import/job-1/confirm', { data: { courseId: 'c-new' } })

  renderCourseManagement()
  choosePackageFile(bigPackageFile())
  await settle()

  // complete 已返回 VALIDATING/PACKAGE_QUEUED：显示校验进度，确认按钮不出现，也还没开始轮询。
  assert.ok(screen.getByTestId('import-validating'), 'validating progress should be visible')
  absent(screen.queryByTestId('import-confirm'), 'confirm must not render while VALIDATING')
  assert.equal(fake.callsTo('GET', '/api/backoffice/courses/import/job-1').length, 0)
  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/package/job-1/complete').length, 1)
  assert.equal(xhrRequests.length, 1, 'one chunk uploaded through the chunked session')

  // 一个轮询周期后到达 AWAITING_CONFIRM：确认按钮出现，校验进度消失，confirm 尚未提交。
  await nextPoll()
  assert.ok(screen.getByTestId('import-confirm'), 'confirm should appear after AWAITING_CONFIRM')
  assert.equal(screen.queryByTestId('import-validating'), null)
  assert.equal(fake.callsTo('GET', '/api/backoffice/courses/import/job-1').length, 1)
  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/job-1/confirm').length, 0)
})

test('课程列表：轮询到 FAILED 显示校验错误并可取消导入', async () => {
  const fake = fakeServer()
  fake.on('POST', '/api/backoffice/courses/import/package/job-1/complete', { data: VALIDATING_JOB })
  fake.on('GET', '/api/backoffice/courses/import/job-1', { data: FAILED_JOB })
  fake.on('POST', '/api/backoffice/courses/import/job-1/cancel', { data: { jobId: 'job-1', status: 'CANCELLED' } })

  renderCourseManagement()
  choosePackageFile(bigPackageFile())
  await settle()
  await nextPoll()

  const error = screen.getByTestId('import-error')
  assert.match(error.textContent ?? '', /Missing video file/)
  absent(screen.queryByTestId('import-confirm'), 'confirm must not render for a failed job')
  const cancel = screen.getByTestId('import-cancel')
  fireEvent.click(cancel)
  await settle()
  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/job-1/cancel').length, 1)
  // 取消后弹窗关闭
  await settle()
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

function renderVersions(onFailure: (action: string, failure: ApiFailure) => void) {
  return render(
    <MemoryRouter>
      <EmployeeContext.Provider value={employee('ADMIN')}>
        <FailureProvider value={onFailure}>
          <CourseVersionsSection
            locale="en-GB"
            course={COURSE}
            versions={[]}
            history={null}
            historyPage={1}
            setHistoryPage={() => {}}
            busy={false}
            setBusy={() => {}}
            onReload={async () => {}}
            onNotice={() => {}}
          />
        </FailureProvider>
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
}

function startVersionImport() {
  fireEvent.click(screen.getByRole('button', { name: 'Import package' }))
  const input = document.querySelector<HTMLInputElement>('input[accept=".zip,.lgcourse.zip"]')
  assert.ok(input, 'version import file input should be rendered')
  fireEvent.change(input, { target: { files: [bigPackageFile()] } })
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
}

test('版本页：complete 返回 VALIDATING 时先 GET 轮询到 AWAITING_CONFIRM，再 POST confirm', async () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.import'] })
  const fake = fakeServer()
  fake.on('POST', '/api/backoffice/courses/import/package/job-1/complete', { data: VALIDATING_JOB })
  fake.on('GET', '/api/backoffice/courses/import/job-1', { data: AWAITING_JOB })
  fake.on('POST', '/api/backoffice/courses/import/job-1/confirm', { data: { courseId: 'c1' } })

  renderVersions(() => {})
  startVersionImport()
  await settle()

  // 上传与 complete 完成，作业仍在 VALIDATING：绝不能直接 confirm。
  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/package/job-1/complete').length, 1)
  assert.equal(fake.callsTo('GET', '/api/backoffice/courses/import/job-1').length, 0)
  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/job-1/confirm').length, 0)

  await nextPoll()

  const polls = fake.callsTo('GET', '/api/backoffice/courses/import/job-1')
  const confirms = fake.callsTo('POST', '/api/backoffice/courses/import/job-1/confirm')
  assert.equal(polls.length, 1)
  assert.equal(confirms.length, 1, 'confirm runs only after AWAITING_CONFIRM')
  const pollIndex = fake.calls.indexOf(polls[0])
  const confirmIndex = fake.calls.indexOf(confirms[0])
  assert.ok(pollIndex < confirmIndex, `poll (${pollIndex}) must precede confirm (${confirmIndex})`)
  assert.deepEqual(confirms[0].body, { onConflict: 'ABORT', overwriteDraft: true })
})

test('版本页：轮询到 FAILED 时不 confirm，并给出明确的失败原因', async () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.import'] })
  const fake = fakeServer()
  fake.on('POST', '/api/backoffice/courses/import/package/job-1/complete', { data: VALIDATING_JOB })
  fake.on('GET', '/api/backoffice/courses/import/job-1', { data: FAILED_JOB })

  const failures: Array<{ action: string; failure: ApiFailure }> = []
  renderVersions((action, failure) => failures.push({ action, failure }))
  startVersionImport()
  await settle()
  await nextPoll()

  assert.equal(fake.callsTo('POST', '/api/backoffice/courses/import/job-1/confirm').length, 0)
  assert.equal(failures.length, 1)
  assert.match(failures[0].failure.message ?? '', /Missing video file/)
})
