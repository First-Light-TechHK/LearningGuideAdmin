// 草稿本地暂存（sessionStorage）：切页签卸载、整页刷新（F5）后，未保存的编辑内容要原样回来。
// 用户批准的行为（不是弹确认）：恢复 + 一条轻提示 + 「丢弃草稿」；保存成功 / 丢弃 / 草稿与服务器一致后不再打扰。
// 这些用例先于实现写成，红在用户路径：当前实现切页签 / 刷新就把输入丢回服务器快照。
import './support/dom'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { CourseDetail, Lesson } from '../src/backoffice/contracts/course'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { CourseEditorPage } from '../src/backoffice/pages/CourseEditorPage'
import { employee, installFakeServer, type FakeServer } from './support/helpdesk-fake'

const KEY_PREFIX = 'lg.bo.course-editor.draft.v1:'
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** 2026-11-20 从全新库抓的真实 GET /courses/:id 响应（完整双语课程，TEXT_ONLY，1 个课时）。 */
function fixture(): CourseDetail {
  return JSON.parse(read('./fixtures/course-completeness-low3.detail.json')) as CourseDetail
}

function locOf(lesson: Lesson, language: string) {
  return lesson.localizations.find((item) => item.language === language)
}

/** 服务器快照 → 当前内容语言下的课时草稿（测试侧独立实现，锁住存储结构）。 */
function serverStudyDraft(detail: CourseDetail, language = 'en-GB') {
  const lesson = detail.lessons[0]
  const en = locOf(lesson, 'en-GB')
  const zh = locOf(lesson, 'zh-CN')
  const current = locOf(lesson, language)
  const time = (seconds: number | null | undefined) =>
    seconds === null || seconds === undefined ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return {
    titleEn: en?.title ?? '',
    titleZh: zh?.title ?? '',
    descEn: en?.description ?? '',
    descZh: zh?.description ?? '',
    videoLps: lesson.learningPoints
      .filter((point) => point.language === language && point.source === 'VIDEO')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((point) => ({ id: point.id, code: point.code, title: point.title, timeText: time(point.timeSeconds) })),
    triggerRows: (lesson.triggers ?? [])
      .filter((trigger) => trigger.language === language)
      .map((trigger) => ({ exhibitId: trigger.exhibitId ?? '', timeText: time(trigger.timeSeconds) })),
    readingRows: lesson.readings.map((reading) => ({
      id: reading.id,
      type: reading.type,
      title: reading.title ?? '',
      author: reading.author ?? '',
      whyRecommended: reading.whyRecommended ?? '',
    })),
    textHtml: current?.textHtml ?? '',
  }
}

type StudyDraftShape = ReturnType<typeof serverStudyDraft>

function studyKey(detail: CourseDetail, language = 'en-GB') {
  return `${KEY_PREFIX}${detail.id}:study:${detail.lessons[0].id}:${language}`
}

function storedStudy(detail: CourseDetail, language = 'en-GB'): { v: number; identity: Record<string, unknown>; base: StudyDraftShape; draft: StudyDraftShape } | null {
  const raw = window.sessionStorage.getItem(studyKey(detail, language))
  return raw ? JSON.parse(raw) : null
}

/** 预置一条草稿记录，模拟「上次会话留下的草稿」。 */
function presetStudyDraft(detail: CourseDetail, base: StudyDraftShape, draft: StudyDraftShape, language = 'en-GB') {
  window.sessionStorage.setItem(
    studyKey(detail, language),
    JSON.stringify({
      v: 1,
      identity: { courseId: detail.id, step: 'study', lessonId: detail.lessons[0].id, language },
      updatedAt: Date.now(),
      base,
      draft,
    }),
  )
}

type EditorServer = {
  fake: FakeServer
  detailGets: () => number
  current: () => CourseDetail
  restore: () => void
}

/** 真页面的假后端：GET 详情每次返回 structuredClone（和真 fetch 一样是新对象）。写接口改内存后由下一次 GET 带出。 */
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
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}`, (call) => {
    const body = call.body as { language: string; title?: string; description?: string; textHtml?: string }
    const localization = current.lessons[0].localizations.find((item) => item.language === body.language)
    if (localization) {
      if (body.title !== undefined) localization.title = body.title
      if (body.description !== undefined) localization.description = body.description
      if (body.textHtml !== undefined) localization.textHtml = body.textHtml
    }
    return { data: structuredClone(current) }
  })
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}/readings`, { data: { readings: [] } })
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}/learning-points`, { data: { points: [] } })
  fake.on('PUT', `/api/backoffice/courses/${id}/lessons/${lessonId}/triggers`, { data: {} })
  fake.on('PUT', `/api/backoffice/courses/${id}/information`, (call) => {
    const body = call.body as {
      categoryId: string | null
      localizations: Record<string, { title: string; shortDescription: string; overview: string; whatYouLearn: string[]; provides: string[] }>
    }
    current.categoryId = body.categoryId ?? null
    for (const [language, side] of Object.entries(body.localizations)) {
      const localization = current.localizations.find((item) => item.language === language)
      if (!localization) continue
      localization.title = side.title
      localization.shortDescription = side.shortDescription
      localization.overview = side.overview
      localization.whatYouLearn = side.whatYouLearn
      localization.provides = side.provides
    }
    return { data: structuredClone(current) }
  })

  return {
    fake,
    detailGets: () => gets,
    current: () => current,
    restore: () => fake.restore(),
  }
}

let server: EditorServer | null = null

beforeEach(() => {
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  server?.restore()
  server = null
})

function renderPage(detail: CourseDetail) {
  render(
    <MemoryRouter initialEntries={[`/en-GB/course/${detail.id}`]}>
      <EmployeeContext.Provider value={employee('ADMIN')}>
        <Routes>
          <Route path="/:locale/course/:courseId" element={<CourseEditorPage />} />
        </Routes>
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
}

function renderEditor(detail: CourseDetail): EditorServer {
  server = installEditorServer(detail)
  renderPage(detail)
  return server
}

async function openTab(tab: 'info' | 'content') {
  fireEvent.click(await screen.findByTestId(`course-tab-${tab}`))
  await screen.findByTestId(tab === 'info' ? 'info-root' : 'content-root')
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

function notice(): HTMLElement | null {
  return screen.queryByTestId('draft-restored')
}

function getInput(testId: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByTestId(testId) as HTMLInputElement | HTMLTextAreaElement
}

function nonGetCalls(): number {
  return server!.fake.calls.filter((call) => call.method !== 'GET').length
}

test('切页签（组件卸载）后恢复未保存的正文与课时标题/简介，并显示恢复提示', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openTab('content')

  const marker = 'DRAFT-TEXT-TAB-20261123'
  typeStudyText(marker)
  const title = 'DRAFT-TITLE-TAB-20261123'
  const description = 'DRAFT-DESC-TAB-20261123'
  fireEvent.change(screen.getByTestId('lesson-title-en'), { target: { value: title } })
  fireEvent.change(screen.getByTestId('lesson-desc-en'), { target: { value: description } })

  // 切到课程信息：Content 被卸载，未保存内容必须已落到 sessionStorage（卸载 flush，不等防抖）。
  fireEvent.click(screen.getByTestId('course-tab-info'))
  await screen.findByTestId('info-root')
  assert.ok(storedStudy(detail), 'unsaved lesson draft should be persisted to sessionStorage on unmount')

  // 切回来：正文 / 标题 / 简介原样恢复，并显示一条恢复提示。
  fireEvent.click(screen.getByTestId('course-tab-content'))
  await screen.findByTestId('content-root')
  assert.match(textEditor().innerHTML, new RegExp(marker))
  assert.equal(getInput('lesson-title-en').value, title)
  assert.equal(getInput('lesson-desc-en').value, description)
  assert.ok(notice(), 'a restore notice should be shown')
  assert.equal(nonGetCalls(), 0, 'restoring a draft must not send any write request')
})

test('模拟整页刷新：卸载后重新挂载，未保存的草稿仍在', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openTab('content')

  const marker = 'DRAFT-TEXT-REFRESH-20261123'
  typeStudyText(marker)
  fireEvent.change(screen.getByTestId('lesson-title-en'), { target: { value: 'DRAFT-TITLE-REFRESH-20261123' } })

  // F5 = 整棵树卸载后重新挂载（sessionStorage 在同一标签页存活）。清理后不重建假后端 = 同一个服务器。
  cleanup()
  assert.ok(storedStudy(detail), 'unmount should flush the draft before the page goes away')

  renderPage(detail)
  await openTab('content')
  assert.match(textEditor().innerHTML, new RegExp(marker))
  assert.equal(getInput('lesson-title-en').value, 'DRAFT-TITLE-REFRESH-20261123')
  assert.ok(notice(), 'the restore notice should be shown after a refresh')
})

test('丢弃草稿：回到服务器值并清除本地草稿，不向服务器写任何请求', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openTab('content')

  typeStudyText('DRAFT-TEXT-DISCARD-20261123')
  fireEvent.change(screen.getByTestId('lesson-title-en'), { target: { value: 'DRAFT-TITLE-DISCARD-20261123' } })

  fireEvent.click(screen.getByTestId('course-tab-info'))
  await screen.findByTestId('info-root')
  fireEvent.click(screen.getByTestId('course-tab-content'))
  await screen.findByTestId('content-root')
  await waitFor(() => assert.ok(notice(), 'the draft should be restored before it can be discarded'))

  fireEvent.click(screen.getByTestId('draft-discard'))

  const serverTitle = locOf(detail.lessons[0], 'en-GB')?.title ?? ''
  await waitFor(() => assert.equal(getInput('lesson-title-en').value, serverTitle, 'discard should reset to the server snapshot'))
  assert.match(textEditor().innerHTML, /Alpha heading/, 'discard should bring back the server text')
  assert.equal(storedStudy(detail), null, 'discard should delete the stored draft')
  assert.equal(notice(), null, 'the notice should disappear after discarding')
  assert.equal(nonGetCalls(), 0, 'discard must not send any write request')
})

test('保存成功后清除本地草稿：重挂载时不再出现恢复提示', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openTab('content')

  const marker = 'DRAFT-TEXT-SAVED-20261123'
  typeStudyText(marker)
  fireEvent.change(screen.getByTestId('lesson-title-en'), { target: { value: 'DRAFT-TITLE-SAVED-20261123' } })
  // 字段变化防抖保存（500ms）：不切页签也会自动落盘。
  await waitFor(() => assert.ok(storedStudy(detail), 'typing should persist a draft before saving'))

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => assert.ok(server!.detailGets() >= 2, 'save should reload the course'))

  // 服务器确实保存了这次输入。
  const lessonPuts = server!.fake.callsTo('PUT', `/api/backoffice/courses/${detail.id}/lessons/${detail.lessons[0].id}`)
  assert.ok(lessonPuts.some((call) => (call.body as { textHtml?: string }).textHtml?.includes(marker)))
  assert.equal(locOf(server!.current().lessons[0], 'en-GB')?.title, 'DRAFT-TITLE-SAVED-20261123')

  // 保存成功 + 重载合并为 clean 后，草稿记录被删除、提示不再出现，输入值保留。
  await waitFor(() => assert.equal(storedStudy(detail), null, 'a saved draft should be removed'))
  assert.equal(notice(), null)
  assert.match(textEditor().innerHTML, new RegExp(marker))

  cleanup()
  renderPage(detail)
  await openTab('content')
  assert.equal(getInput('lesson-title-en').value, 'DRAFT-TITLE-SAVED-20261123')
  assert.equal(notice(), null, 'no restore notice after a successful save')
})

test('草稿与服务端完全一致时视为无草稿：不提示并删除记录', async () => {
  const detail = fixture()
  presetStudyDraft(detail, serverStudyDraft(detail), serverStudyDraft(detail))
  renderEditor(detail)
  await openTab('content')

  assert.equal(notice(), null, 'a clean stored draft must not trigger the restore notice')
  await waitFor(() => assert.equal(storedStudy(detail), null, 'a clean stored draft should be deleted'))
})

test('服务器在草稿期间更新：只保留用户改过的字段，并提示服务器已更新', async () => {
  const detail = fixture()
  const base = serverStudyDraft(detail)
  const draft = { ...base, titleEn: 'DRAFT-TITLE-MINE' }
  presetStudyDraft(detail, base, draft)
  // 服务器在草稿期间更新了正文（别处保存过）。
  locOf(detail.lessons[0], 'en-GB')!.textHtml = '<h1>SERVER-NEW Heading</h1><p>Updated on the server.</p>'

  renderEditor(detail)
  await openTab('content')

  assert.equal(getInput('lesson-title-en').value, 'DRAFT-TITLE-MINE', 'the field the user edited keeps the draft')
  assert.match(textEditor().innerHTML, /SERVER-NEW/, 'untouched fields follow the latest server snapshot')
  assert.ok(notice())
  assert.ok(screen.getByTestId('draft-server-changed'), 'the notice should say the server changed in the meantime')
})

test('课程信息：切页签恢复课程名/概述/学习条目；保存成功后清除草稿', async () => {  const detail = fixture()
  renderEditor(detail)
  await screen.findByTestId('info-root')

  fireEvent.change(screen.getByTestId('info-title-en'), { target: { value: 'INFO-TITLE-DRAFT-20261123' } })
  fireEvent.change(screen.getByTestId('info-overview-en'), { target: { value: 'INFO-OVERVIEW-DRAFT-20261123' } })
  fireEvent.change(screen.getByTestId('learn-en-0'), { target: { value: 'INFO-LEARN-DRAFT-20261123' } })

  fireEvent.click(screen.getByTestId('course-tab-content'))
  await screen.findByTestId('content-root')
  const infoKey = `${KEY_PREFIX}${detail.id}:info`
  assert.ok(window.sessionStorage.getItem(infoKey), 'course info draft should be persisted on unmount')

  fireEvent.click(screen.getByTestId('course-tab-info'))
  await screen.findByTestId('info-root')
  assert.equal(getInput('info-title-en').value, 'INFO-TITLE-DRAFT-20261123')
  assert.equal(getInput('info-overview-en').value, 'INFO-OVERVIEW-DRAFT-20261123')
  assert.equal(getInput('learn-en-0').value, 'INFO-LEARN-DRAFT-20261123')
  assert.ok(notice(), 'course info should show the restore notice too')

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => assert.ok(server!.detailGets() >= 2, 'saving course info should reload the course'))
  const infoPuts = server!.fake.callsTo('PUT', `/api/backoffice/courses/${detail.id}/information`)
  assert.ok(infoPuts.length >= 1)
  const savedSide = (infoPuts.at(-1)!.body as { localizations: Record<string, { title: string }> }).localizations['en-GB']
  assert.equal(savedSide.title, 'INFO-TITLE-DRAFT-20261123')

  await waitFor(() => assert.equal(window.sessionStorage.getItem(infoKey), null, 'saved course info draft should be removed'))
  assert.equal(notice(), null)
  assert.equal(getInput('info-title-en').value, 'INFO-TITLE-DRAFT-20261123')
})

test('理解测试：切到学习再切回恢复未保存的题目；丢弃后回到服务器值', async () => {
  const detail = fixture()
  renderEditor(detail)
  await openTab('content')

  fireEvent.click(await screen.findByRole('button', { name: /Understanding/ }))
  fireEvent.click(screen.getByRole('button', { name: /Add question/ }))
  const questionInput = document.querySelector<HTMLInputElement>('input[data-new-question="true"]')
  assert.ok(questionInput, 'a new question input should be rendered')
  fireEvent.change(questionInput, { target: { value: 'DRAFT-KNOWLEDGE-QUESTION-20261123' } })
  const answerInput = document.querySelector<HTMLTextAreaElement>('textarea')
  assert.ok(answerInput, 'the reference answer textarea should be rendered')
  fireEvent.change(answerInput, { target: { value: 'DRAFT-KNOWLEDGE-ANSWER-20261123' } })

  // 切回 Study（UnderstandingPanel 卸载）再切回来：题目与参考答案恢复。
  fireEvent.click(screen.getByRole('button', { name: /^Study & Exploration/ }))
  await waitFor(() => assert.equal(document.querySelector('input[data-new-question="true"]'), null))
  fireEvent.click(screen.getByRole('button', { name: /Understanding/ }))
  await waitFor(() => {
    const restored = document.querySelector<HTMLInputElement>('input[data-new-question="true"]')
    assert.equal(restored?.value, 'DRAFT-KNOWLEDGE-QUESTION-20261123')
  })
  assert.ok(notice(), 'the understanding panel should show the restore notice')
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')?.value, 'DRAFT-KNOWLEDGE-ANSWER-20261123')

  // 丢弃：回到服务器值（服务器上没有题目），存储记录删除。
  const understandingKey = `${KEY_PREFIX}${detail.id}:understanding:${detail.lessons[0].id}:en-GB`
  fireEvent.click(screen.getByTestId('draft-discard'))
  await waitFor(() => assert.equal(document.querySelector('input[data-new-question="true"]'), null))
  assert.equal(window.sessionStorage.getItem(understandingKey), null)
  assert.equal(nonGetCalls(), 0, 'restoring/discarding understanding drafts must not send any write request')
})

test('课程信息：非保存重载（重新加载）不覆盖未保存的字段（P96）', async () => {
  const detail = fixture()
  renderEditor(detail)
  await screen.findByTestId('info-root')

  fireEvent.change(screen.getByTestId('info-title-en'), { target: { value: 'INFO-TITLE-RELOAD-20261123' } })
  fireEvent.change(screen.getByTestId('info-overview-en'), { target: { value: 'INFO-OVERVIEW-RELOAD-20261123' } })

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await waitFor(() => assert.ok(server!.detailGets() >= 2, 'the reload button should refetch the course'))
  await waitFor(() => {
    assert.equal(getInput('info-title-en').value, 'INFO-TITLE-RELOAD-20261123', 'unsaved fields must survive a plain refetch')
    assert.equal(getInput('info-overview-en').value, 'INFO-OVERVIEW-RELOAD-20261123')
  })
  // 没改过的字段仍跟随服务器（重新载入后的快照）。
  assert.equal(getInput('info-desc-en').value, detail.localizations.find((item) => item.language === 'en-GB')?.shortDescription ?? '')
})
