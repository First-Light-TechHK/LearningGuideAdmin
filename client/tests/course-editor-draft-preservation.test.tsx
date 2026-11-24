// X（用户现场，SIT）：课程包导入后手动补内容时，任何一次课程重载（上传展品、保存/删除展品……
// 都会走 onReload）都会把 CourseContentSection 里未保存的草稿重置成服务器快照。
// 用户步骤：Course Content → 输入学习文本 / 课时标题简介（不点底部 Save）→「+ Upload exhibits」
// → 文本被清空、lesson info 回退（before2 证据 x1/x4/x5）。根因是 L130-177 按对象引用同步草稿：
// GET 详情每次都返回新对象，draftSource.course !== course 恒成立，草稿全部 set 回服务器值。
// 这里锁住修复后的语义：
//   1) 重载不再吞掉未保存草稿（脏字段保留），未改动的字段仍跟随服务器；
//   2) 切换内容语言（= 课时身份变化）仍从服务器整份重新取草稿；
//   3) lesson info 填好并保存后，必填提示按服务器新快照刷新（Y 的良性路径，修复前后都应绿）。
import './support/dom'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { CourseDetail, CourseIssue } from '../src/backoffice/contracts/course'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { CourseEditorPage } from '../src/backoffice/pages/CourseEditorPage'
import { employee, installFakeServer, type FakeServer } from './support/helpdesk-fake'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** 2026-11-20 从全新库抓的真实 GET /courses/:id 响应（完整双语课程，TEXT_ONLY，1 个课时）。 */
function fixture(): CourseDetail {
  return JSON.parse(read('./fixtures/course-completeness-low3.detail.json')) as CourseDetail
}

/** 导入后、还没手填学习内容的形态：两种语言的正文都是空的。 */
function importedShape(): CourseDetail {
  const detail = fixture()
  for (const lesson of detail.lessons) {
    for (const localization of lesson.localizations) localization.textHtml = null
  }
  return detail
}

type XhrRequest = { method: string; url: string }
let xhrRequests: XhrRequest[] = []

/** 「+ Upload exhibits」的单个文件上传走 XMLHttpRequest：立即成功，返回 media 资产。 */
function installFakeXhr(): () => void {
  const original = globalThis.XMLHttpRequest
  class FakeXhr {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    status = 200
    statusText = 'OK'
    responseText = JSON.stringify({
      success: true,
      data: { id: 'asset-1', kind: 'IMAGE', originalName: 'probe-exhibit.png' },
    })
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

type EditorServer = {
  fake: FakeServer
  detailGets: () => number
  current: () => CourseDetail
  restore: () => void
}

/**
 * 真页面的假后端：GET 详情每次返回 structuredClone（和真 fetch 一样是新对象，正是重置块的触发条件）。
 * 写接口按服务器语义改内存里的 course，再让下一次 GET 带出来。
 */
function installEditorServer(initial: CourseDetail): EditorServer {
  const fake = installFakeServer()
  let current = structuredClone(initial)
  let gets = 0
  const id = initial.id
  const lessonId = initial.lessons[0].id

  fake.on('GET', `/api/backoffice/courses/${id}`, () => {
    gets += 1
    return { data: structuredClone(current) }
  })
  fake.on('GET', `/api/backoffice/courses/${id}/trial`, {
    data: { enabled: false, learningMode: initial.learningMode, learningLanguages: initial.learningLanguages, rows: [] },
  })
  fake.on('GET', `/api/backoffice/courses/${id}/versions`, { data: [] })
  fake.on('GET', `/api/backoffice/courses/${id}/history`, { data: { items: [], total: 0, page: 1, pages: 1 } })
  fake.on('GET', '/api/backoffice/courses/categories', { data: [] })
  fake.on('GET', '/api/backoffice/courses/media-limits', {
    data: { imageBytes: 20_000_000, videoBytes: 500_000_000, audioBytes: 10_000_000, pdfBytes: 20_000_000, modelBytes: 25_000_000, chunkSize: 5_000_000 },
  })
  fake.on('POST', `/api/backoffice/courses/${id}/lessons/${lessonId}/exhibits`, () => {
    current.lessons[0].exhibits.push({ id: 'exhibit-1', code: 'E001', type: 'IMAGE', media: null, thumbnail: null, localized: {} })
    return { data: {} }
  })
  fake.on('PUT', new RegExp(`^/api/backoffice/courses/${id}/lessons/${lessonId}/exhibits/`), { data: {} })
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}`, (call) => {
    const body = call.body as { language: string; title?: string; description?: string; textHtml?: string }
    const localization = current.lessons[0].localizations.find((item) => item.language === body.language)
    if (localization) {
      if (body.title !== undefined) localization.title = body.title
      if (body.description !== undefined) localization.description = body.description
      if (body.textHtml !== undefined) localization.textHtml = body.textHtml
    }
    if (body.description !== undefined && body.description.trim()) {
      // 服务器重算完整性：补上简介后，这条 REQUIRED 消失。
      current.completeness.issues = (current.completeness.issues ?? []).filter(
        (issue) => !(issue.step === 'COURSE_CONTENT' && issue.lessonId === lessonId && issue.field === 'description'),
      );
      const step = (current.completeness.steps.content.lessons ?? []).find((item) => item.lessonId === lessonId)
      if (step) {
        step.missing = []
        step.issues = []
        step.infoComplete = true
      }
    }
    return { data: structuredClone(current) }
  })
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}/readings`, { data: { readings: [] } })

  return {
    fake,
    detailGets: () => gets,
    current: () => current,
    restore: () => fake.restore(),
  }
}

let restoreXhr: (() => void) | null = null
let server: EditorServer | null = null

beforeEach(() => {
  xhrRequests = []
  restoreXhr = installFakeXhr()
})

afterEach(() => {
  cleanup()
  restoreXhr?.()
  restoreXhr = null
  server?.restore()
  server = null
})

function renderEditor(detail: CourseDetail): EditorServer {
  server = installEditorServer(detail)
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

async function openContentTab() {
  const tab = await screen.findByRole('button', { name: /Course Content/ })
  fireEvent.click(tab)
  await screen.findByTestId('content-root')
}

function textEditor(): HTMLDivElement {
  const editor = document.querySelector<HTMLDivElement>('[contenteditable="true"]')
  assert.ok(editor, 'study text editor should be rendered')
  return editor
}

/** 在正文编辑器里输入（TextEditor 的 onInput 读 currentTarget.innerHTML）。 */
function typeStudyText(marker: string) {
  const editor = textEditor()
  editor.innerHTML = `<h1>${marker} Heading</h1><p>${marker} paragraph typed before saving anything.</p>`
  fireEvent.input(editor)
  return editor
}

/** 用户现场 X1 的动作：Exhibits 区「+ Upload exhibits」选一张图片。 */
function uploadExhibit() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')
  assert.ok(input, 'batch exhibit upload input should be rendered')
  fireEvent.change(input, {
    target: { files: [new File(['image-bytes'], 'probe-exhibit.png', { type: 'image/png' })] },
  })
}

async function waitForReloadToApply() {
  await waitFor(() => {
    assert.ok((server?.detailGets() ?? 0) >= 2, 'the course should be reloaded after the exhibit action')
  })
}

test('X1/X5：未保存的学习文本和 lesson info 在上传展品触发的重载后不再消失（且展品已落库）', async () => {
  const detail = importedShape()
  renderEditor(detail)
  await openContentTab()

  const marker = 'PROBE-TEXT-DRAFT-20261123'
  typeStudyText(marker)
  const title = 'PROBE-TITLE-DRAFT-20261123'
  const description = 'PROBE-DESC-DRAFT-20261123'
  fireEvent.change(screen.getByTestId('lesson-title-en'), { target: { value: title } })
  fireEvent.change(screen.getByTestId('lesson-desc-en'), { target: { value: description } })

  uploadExhibit()
  await waitForReloadToApply()
  // 展品行出现 = 重载带回的新数据已经渲染；修复前编辑器在这一步已经被重置成服务器空文本。
  await screen.findByTestId('exhibit-row')

  assert.match(textEditor().innerHTML, new RegExp(marker), 'unsaved study text must survive the exhibit reload')
  assert.equal((screen.getByTestId('lesson-title-en') as HTMLInputElement).value, title)
  assert.equal((screen.getByTestId('lesson-desc-en') as HTMLTextAreaElement).value, description)
  // 未保存的内容仍然没有被偷偷保存——重载只是不再覆盖草稿。
  assert.equal(server!.current().lessons[0].exhibits.length, 1)
})

test('X4：在展品抽屉里保存展品触发的重载同样不吞未保存的学习文本', async () => {
  const detail = fixture()
  detail.lessons[0].exhibits.push({
    id: 'exhibit-1',
    code: 'E001',
    type: 'IMAGE',
    media: { id: 'media-1' },
    thumbnail: { id: 'thumb-1' },
    localized: {
      'en-GB': { title: 'Existing exhibit', description: 'Already complete.' },
      'zh-CN': { title: '已有展品', description: '已经补齐。' },
    },
  })
  for (const localization of detail.lessons[0].localizations) localization.textHtml = null
  renderEditor(detail)
  await openContentTab()

  const marker = 'PROBE-TEXT-DRAWER-20261123'
  typeStudyText(marker)

  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save exhibit' }))
  await waitForReloadToApply()

  await waitFor(() => {
    assert.match(textEditor().innerHTML, new RegExp(marker), 'unsaved study text must survive the exhibit drawer reload')
  })
})

test('切换内容语言仍是身份变化：草稿从服务器整份重新取（不会把英文草稿带进中文）', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openContentTab()

  const marker = 'PROBE-TEXT-EN-ONLY-20261123'
  typeStudyText(marker)

  const select = document.querySelector<HTMLSelectElement>('.course-ui-lang select')
  assert.ok(select, 'content language selector should be rendered for a bilingual course')
  fireEvent.change(select, { target: { value: 'zh-CN' } })

  await waitFor(() => {
    assert.match(textEditor().innerHTML, /贝塔标题/, 'Chinese draft should come from the server snapshot')
  })
  assert.doesNotMatch(textEditor().innerHTML, new RegExp(marker))
})

test('Y 的良性路径：lesson info 填好并保存后，服务器重算的必填提示随之消失（英文简介）', async () => {
  const detail = fixture()
  const lesson = detail.lessons[0]
  const lessonId = lesson.id
  const localizations = lesson.localizations
  const en = localizations.find((item) => item.language === 'en-GB')!
  en.description = ''
  detail.completeness.issues = [
    {
      code: 'REQUIRED',
      step: 'COURSE_CONTENT',
      part: 'LESSON_INFO',
      lessonId,
      lessonCode: lesson.code,
      lessonPosition: 1,
      language: 'en-GB',
      field: 'description',
      message: 'Required',
    } satisfies CourseIssue,
  ]
  renderEditor(detail)
  await openContentTab()

  await screen.findByTestId('lesson-desc-en')
  await waitFor(() => {
    assert.equal(screen.getAllByTestId('field-issue').length, 1, 'English description should show the server Required hint')
  })

  fireEvent.change(screen.getByTestId('lesson-desc-en'), { target: { value: 'PROBE-DESC-SAVED-20261123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitForReloadToApply()

  // 保存序列确实把双语课时信息发给了服务器。
  const lessonPuts = server!.fake.callsTo('PUT', `/api/backoffice/courses/${detail.id}/lessons/${lessonId}`)
  assert.ok(lessonPuts.some((call) => (call.body as { description?: string }).description === 'PROBE-DESC-SAVED-20261123'))
  // 保存后按服务器新快照刷新：必填提示消失，输入值保留。
  await waitFor(() => {
    assert.equal(screen.queryAllByTestId('field-issue').length, 0, 'Required should clear after save + reload')
  })
  assert.equal((screen.getByTestId('lesson-desc-en') as HTMLTextAreaElement).value, 'PROBE-DESC-SAVED-20261123')
})
