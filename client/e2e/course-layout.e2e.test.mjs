// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：课程页 RWD 布局契约。
// 锁住：页面本体不滚动（KPI：document / .content / 页面卡片三层都不滚）、吸顶页签、
// 面板内部滚动（版本列表、历史记录、课程列表表格）、无横向溢出、
// 版本页 Current / Versions / History 分段不纵向堆叠、1672×941 与 1280×800 两种视口。
// 运行：cd client && node --test e2e/course-layout.e2e.test.mjs（本地跑，CI 不装浏览器）。
// 截图：仅在设置了 UIUX_SHOTS 时保存（与其它 e2e 的 E2E_SHOTS 约定一致）。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.UIUX_SHOTS || null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let server
let browser
let base

before(async () => {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  const executablePath = process.env.PW_CHROMIUM || undefined
  browser = await chromium.launch(executablePath ? { executablePath, args: ['--headless=new', '--no-sandbox'] } : {})
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const ok = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message } }) })

const WHEN = '2026-11-02T08:30:00.000Z'
const SESSION = { employee: { employeeId: 'e1', loginEmail: 'olive@example.com', role: 'ADMIN', displayName: 'Olive', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
const CATEGORIES = [{ id: 'cat', name: 'Science' }]
const SUMMARY = { id: 'c1', code: 'CRS-1', slug: 'modelling-life', title: 'Modelling Life', subtitle: null, category: { id: 'cat', name: 'Science' }, learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'], lessonCount: 5, lifecycleStatus: 'PUBLISHED', liveStatus: 'ONLINE', liveVersionId: 'v26', liveVersionLabel: 'V4.2', liveVersionWentLiveAt: WHEN, hasDraft: true, trialEnabled: true, published: true, updatedAt: WHEN }
const lessonLocs = (language, title) => ({ language, title, description: title, textHtml: '<h1>x</h1>', videoAssetId: 'a1', video: { id: 'a1', originalName: 'x.mp4', size: 1024, mimeType: 'video/mp4', extension: 'mp4', createdAt: WHEN }, videoDurationSeconds: 60 })
const LESSON = (n) => ({
  id: `l${n}`, code: `LS-${n}`, sortOrder: n - 1,
  localizations: [lessonLocs('en-GB', `Modelling Life ${n}`), lessonLocs('zh-CN', `生命建模 ${n}`)],
  exhibits: [], readings: [], questions: [], applicationTest: null, triggers: [],
  learningPoints: [{ id: `p${n}`, language: 'en-GB', code: 'L1', title: 'Point one', source: 'MANUAL', timeSeconds: 10 }],
})
const LESSONS = [1, 2, 3, 4, 5].map(LESSON)
const DETAIL = {
  ...SUMMARY,
  defaultContentLanguage: 'en-GB', categoryId: 'cat', cover: null,
  localizations: [
    { language: 'en-GB', title: 'Modelling Life', shortDescription: 'Modelling Life', overview: 'Modelling Life', whatYouLearn: ['Understand modelling'], provides: ['Video lessons'] },
    { language: 'zh-CN', title: '生命建模', shortDescription: '生命建模', overview: '生命建模', whatYouLearn: [], provides: [] },
  ],
  lessons: LESSONS, plans: [], trialRows: [],
  completeness: {
    steps: { courseInformation: { complete: true, missing: [] }, content: { complete: false, missing: ['Lesson LS-2: title is required (en-GB)'] }, trial: { complete: true, missing: [] } },
    completedSteps: 2, canPublish: false, publishBlockers: [],
  },
}
const TRIAL = {
  enabled: true, learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'],
  rows: LESSONS.map((lesson, index) => ({ lessonId: lesson.id, code: lesson.code, index: index + 1, title: `Modelling Life ${index + 1}`, videoDurationSeconds: 60, inTrial: index < 2, videoCutoffSeconds: 30, textCutoffLearningPointId: null, textCutoffCode: null, status: 'READY', learningPoints: [] })),
}
// 足够多的版本（>一屏）用来验证 Versions 分段在面板内部滚动。
const VERSIONS = Array.from({ length: 26 }, (_, index) => ({
  id: `v${index + 1}`, versionNo: index + 1, versionLabel: `V${(index + 1).toFixed(1)}`, versionSeries: index + 1, versionMinor: 0,
  sourceEnvironment: index === 0 ? null : 'Sandbox', sourceVersionLabel: index === 0 ? null : `V${index.toFixed(1)}`,
  wentLiveAt: WHEN, exportedAt: null, createdAt: WHEN, isLive: index === 25,
}))
// 两页历史（分页保留），20 条一页同样超过一屏。
const HISTORY = {
  items: Array.from({ length: 20 }, (_, index) => ({ id: `h${index + 1}`, time: WHEN, operator: 'Olive', action: 'PUBLISH', versionNo: index + 1, detail: { versionLabel: `V${(index + 1).toFixed(1)}` } })),
  total: 40, page: 1, pages: 2,
}
const MEDIA_LIMITS = { imageBytes: 10485760, videoBytes: 1073741824, audioBytes: 209715200, pdfBytes: 52428800, modelBytes: 104857600, chunkSize: 8388608 }
const COURSE_ROW = (n) => ({
  ...SUMMARY, id: `c${n}`, code: `CRS-${n}`, slug: `course-${n}`, title: `Course ${n}`, hasDraft: n % 3 === 0, liveVersionLabel: n % 4 === 0 ? null : `V${n}.0`, published: n % 4 !== 0, liveStatus: n % 4 === 0 ? null : 'ONLINE',
})
const COURSE_LIST = {
  courses: Array.from({ length: 12 }, (_, index) => COURSE_ROW(index + 1)),
  total: 54, page: 1, pages: 5,
  counts: { total: 54, draft: 18, published: 40, online: 36, hidden: 4, offline: 0, notPublished: 14 },
}

async function open(viewport, locale = 'en-GB') {
  const context = await browser.newContext({ locale, timezoneId: 'Asia/Shanghai', viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => console.error('pageerror', error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/session') return route.fulfill(ok(SESSION))
    if (path === '/api/health') return route.fulfill(ok({ status: 'ok', service: 'learning-guide-admin', environment: 'SANDBOX' }))
    if (path === '/api/backoffice/environment') return route.fulfill(ok({ label: 'Sandbox', publicSiteUrl: 'https://sandbox.example.com', versionNumberingMode: 'sandbox', stripeConfigured: false }))
    if (path === '/api/backoffice/courses/categories') return route.fulfill(ok(CATEGORIES))
    if (path === '/api/backoffice/courses/media-limits') return route.fulfill(ok(MEDIA_LIMITS))
    if (path === '/api/backoffice/courses') return route.fulfill(ok(COURSE_LIST))
    if (path === '/api/backoffice/courses/c1') return route.fulfill(ok(DETAIL))
    if (path === '/api/backoffice/courses/c1/trial') return route.fulfill(ok(TRIAL))
    if (path === '/api/backoffice/courses/c1/versions') return route.fulfill(ok(VERSIONS))
    if (path === '/api/backoffice/courses/c1/history') return route.fulfill(ok(HISTORY))
    return route.fulfill(fail(404, 'NOT_FOUND', '请求的资源不存在'))
  })
  return { context, page }
}

async function shot(page, name) {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** 三层滚动容器：文档、壳层内容区、页面卡片本体。 */
async function scrollState(page, pageTestId) {
  return page.evaluate((testId) => {
    const measure = (el) => el && ({ scrollY: el.scrollHeight, clientY: el.clientHeight, scrollX: el.scrollWidth, clientX: el.clientWidth })
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: measure(document.scrollingElement),
      content: measure(document.querySelector('.content')),
      page: measure(document.querySelector(`[data-testid="${testId}"]`)),
    }
  }, pageTestId)
}

/** 环境墙：钥石可见并写着 Sandbox；应用面在墙内（墙内缩只让外壳变小，不产生页面滚动）。 */
async function assertWall(page, label) {
  const keystone = page.getByTestId('env-keystone')
  await keystone.waitFor()
  assert.ok(await keystone.isVisible(), `${label}: 钥石应可见`)
  assert.match(await keystone.innerText(), /sandbox/i, `${label}: 钥石应写着 Sandbox`)
  const boxes = await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom } }
    return { wall: rect(document.querySelector('.envWall')), surface: rect(document.querySelector('.appSurface')) }
  })
  assert.ok(boxes.surface.x >= boxes.wall.x && boxes.surface.y >= boxes.wall.y && boxes.surface.r <= boxes.wall.r + 0.5 && boxes.surface.b <= boxes.wall.b + 0.5, `${label}: .appSurface 应在 .envWall 内`)
}

async function assertPageDoesNotScroll(page, pageTestId, label) {
  await assertWall(page, label)
  const m = await scrollState(page, pageTestId)
  const { width, height } = m.viewport
  assert.ok(m.document.scrollY <= height + 1, `${label}: 文档不应纵向滚动（scrollHeight ${m.document.scrollY} > innerHeight ${height}）`)
  assert.ok(m.document.scrollX <= width + 1, `${label}: 文档不应横向滚动（scrollWidth ${m.document.scrollX} > innerWidth ${width}）`)
  if (m.content) {
    assert.ok(m.content.scrollY <= m.content.clientY + 1, `${label}: 页面容器 .content 不应纵向滚动（scrollHeight ${m.content.scrollY} > clientHeight ${m.content.clientY}）`)
    assert.ok(m.content.scrollX <= m.content.clientX + 1, `${label}: 页面容器 .content 不应横向溢出（scrollWidth ${m.content.scrollX} > clientWidth ${m.content.clientX}）`)
  }
  if (m.page) {
    assert.ok(m.page.scrollY <= m.page.clientY + 1, `${label}: 页面卡片本体不应滚动（scrollHeight ${m.page.scrollY} > clientHeight ${m.page.clientY}）`)
    assert.ok(m.page.scrollX <= m.page.clientX + 1, `${label}: 页面卡片本体不应横向溢出（scrollWidth ${m.page.scrollX} > clientWidth ${m.page.clientX}）`)
  }
}

async function assertTabsStickyAndPanelBounded(page, label) {
  const tabs = page.getByTestId('course-tabs')
  await tabs.waitFor()
  const tabsBox = await tabs.boundingBox()
  assert.ok(tabsBox && tabsBox.height > 20, `${label}: 页签栏应可见`)
  const position = await tabs.evaluate((el) => getComputedStyle(el).position)
  assert.equal(position, 'sticky', `${label}: 页签栏应吸顶（position: sticky），当前 ${position}`)
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  assert.ok(tabsBox.y >= 0 && tabsBox.y + tabsBox.height <= viewport.height + 1, `${label}: 页签栏应在视口内`)

  const panel = page.locator('[data-course-tab-panel]')
  assert.equal(await panel.count(), 1, `${label}: 应恰有一个页签内容面板`)
  const panelBox = await panel.boundingBox()
  assert.ok(panelBox && panelBox.height > 150, `${label}: 面板应有确定高度，实际 ${panelBox?.height}`)
  assert.ok(panelBox.y >= tabsBox.y + tabsBox.height - 1, `${label}: 面板应在页签栏下方`)
  assert.ok(panelBox.y + panelBox.height <= viewport.height + 1, `${label}: 面板不应超出视口底边`)
  const overflow = await panel.evaluate((el) => getComputedStyle(el).overflow)
  assert.equal(overflow, 'hidden', `${label}: 面板容器应裁切内容（overflow: hidden），滚动交给内部面板`)
}

/** 可滚动断言：内容确实超出，且能通过 scrollTop 滚动。 */
async function assertScrollable(page, testId, label) {
  const el = page.getByTestId(testId)
  await el.waitFor()
  const metrics = await el.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY }))
  assert.ok(metrics.scrollHeight > metrics.clientHeight + 1, `${label}: 内容应超出面板（scrollHeight ${metrics.scrollHeight} vs clientHeight ${metrics.clientHeight}）`)
  assert.ok(['auto', 'scroll'].includes(metrics.overflowY), `${label}: 面板应内部滚动（overflow-y ${metrics.overflowY}）`)
  const scrolled = await el.evaluate((node) => {
    node.scrollTop = 120
    return node.scrollTop
  })
  assert.ok(scrolled > 0, `${label}: 面板应能实际滚动`)
  await el.evaluate((node) => {
    node.scrollTop = 0
  })
}

/** 版本页：同一屏看草稿板、线上板和列表（两栏），内容在 versions-scroll 内滚动，文档不滚动。 */
async function assertVersionsPane(page, label) {
  await page.getByTestId('course-tab-versions').click()
  await page.waitForTimeout(250)
  // one "History ↓" link replaces the old three-link row (the pane already shows Current and Versions together)
  assert.equal(await page.getByTestId('versions-segment-history').count(), 1, `${label}: 应有 History 跳转`)
  assert.equal(await page.getByTestId('versions-segment-current').count(), 0, `${label}: 不再有 Current 跳转`)
  // Live tag text is whole inside its cell
  const tag = page.locator('.course-ui-liveTag').first()
  assert.equal((await tag.innerText()).trim(), 'Live', `${label}: Live 标签文字可见`)
  const tagBox = await tag.boundingBox()
  const cellBox = await tag.locator('xpath=ancestor::td[1]').boundingBox()
  assert.ok(tagBox.width >= 24 && tagBox.x + tagBox.width <= cellBox.x + cellBox.width + 1, `${label}: Live 标签应完整落在单元格内`)
  const draftBox = await page.getByTestId('versions-current-draft').boundingBox()
  const liveBox = await page.getByTestId('versions-current-live').boundingBox()
  const listBox = await page.getByTestId('versions-list').boundingBox()
  assert.ok(draftBox && liveBox && listBox, `${label}: 草稿板、线上板、列表应同时存在`)
  assert.ok(Math.abs(draftBox.x - liveBox.x) <= 2, `${label}: 草稿板与线上板应同列（x ${draftBox.x} vs ${liveBox.x}）`)
  assert.ok(draftBox.y + draftBox.height <= liveBox.y + 1, `${label}: 草稿板应在线上板上方`)
  assert.ok(draftBox.x + draftBox.width < listBox.x && liveBox.x + liveBox.width < listBox.x, `${label}: 两块板都应在列表左侧`)
  await assertScrollable(page, 'versions-scroll', `${label} 版本页`)
  await assertPageDoesNotScroll(page, 'course-editor-page', `${label} 版本页`)
}

const EDITOR_TABS = [
  ['info', 'Course Information'],
  ['content', 'Course Content'],
  ['trial', 'Trial'],
  ['versions', 'Versions & publishing'],
]

async function editorTabState(page, viewportName, tabId) {
  await page.getByTestId(`course-tab-${tabId}`).click()
  await page.waitForTimeout(200)
  const label = `${viewportName} 课程编辑/${tabId}`
  await assertPageDoesNotScroll(page, 'course-editor-page', label)
  await assertTabsStickyAndPanelBounded(page, label)
  await shot(page, `editor-${tabId}-${viewportName}`)
}

test('1672×941：课程编辑每个页签页面本体不滚动、吸顶页签、面板内滚动', async () => {
  const { context, page } = await open({ width: 1672, height: 941 })
  try {
    await page.goto(`${base}/en-GB/course/c1`)
    await page.waitForLoadState('networkidle')

    // 状态只在头部摘要出现一次；页签不重复线上/草稿状态。
    const summary = page.getByTestId('course-status-summary')
    assert.equal(await summary.count(), 1, '头部应恰有一行状态摘要')
    const summaryText = await summary.innerText()
    assert.match(summaryText, /Draft/i, '状态摘要应包含 Draft 完成度')
    assert.match(summaryText, /Live/i, '状态摘要应包含 Live 版本')
    assert.equal(Math.round((await summary.boundingBox()).height), 40, '状态摘要应是一行 40px 高')
    assert.equal(await page.locator('[data-testid="course-editor-page"] > header').getByRole('button', { name: /Versions & publishing/ }).count(), 0, '页头不应再有“Versions & publishing”按钮')
    const tabsText = await page.getByTestId('course-tabs').innerText()
    assert.doesNotMatch(tabsText, /Online|Hidden|Offline/, '页签不应重复线上状态')

    for (const [tabId] of EDITOR_TABS) {
      await editorTabState(page, '1672', tabId)
    }

    // 版本与发布：Draft 板在上、Live 板在下（同一列），列表在它们右侧；整页在 versions-scroll 内滚动。
    await assertVersionsPane(page, '1672')
    await shot(page, 'editor-versions-1672')

    // 三个“本页内容”按钮只在 Versions 页签出现；点 History 把历史带进视野，分页可达。
    await page.getByTestId('versions-segment-history').click()
    await page.waitForTimeout(250)
    const pagination = page.getByTestId('versions-history-pagination')
    await pagination.waitFor()
    assert.ok(await pagination.isVisible(), '历史记录分页应可达')
    await assertPageDoesNotScroll(page, 'course-editor-page', '1672 历史记录')
    await page.getByTestId('course-tab-info').click()
    assert.equal(await page.getByTestId('versions-segment-history').count(), 0, '其它页签不应有“本页内容”按钮')
  } finally {
    await context.close()
  }
})

test('1672×941：课程列表页页面本体不滚动、表格内滚动、分页固定底部', async () => {
  const { context, page } = await open({ width: 1672, height: 941 })
  try {
    await page.goto(`${base}/en-GB/course`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-overview-table-wrap').waitFor()

    await assertPageDoesNotScroll(page, 'course-overview-page', '1672 课程列表')
    assert.equal(await page.getByRole('heading', { name: 'Course Overview' }).count(), 1, '页头标题应为 Course Overview')
    for (const name of ['Operations', 'Create course', 'Import']) {
      assert.ok(await page.getByRole('button', { name }).first().isVisible(), `页头应有 ${name} 动作`)
    }
    await assertScrollable(page, 'course-overview-table-wrap', '1672 课程表格')
    const pagination = page.getByTestId('course-overview-pagination')
    await pagination.waitFor()
    const before = await pagination.boundingBox()
    await page.getByTestId('course-overview-table-wrap').evaluate((node) => {
      node.scrollTop = 160
    })
    const after = await pagination.boundingBox()
    assert.ok(Math.abs(before.y - after.y) <= 1, '分页条应固定在卡片底部，不随表格滚动')
    const viewport = await page.evaluate(() => ({ height: window.innerHeight }))
    assert.ok(after.y + after.height <= viewport.height + 1, '分页条应在视口内')
    await assertPageDoesNotScroll(page, 'course-overview-page', '1672 课程列表（表格滚动后）')
    await shot(page, 'course-overview-1672')
  } finally {
    await context.close()
  }
})

test('1280×800：同样的布局契约仍然成立', async () => {
  const { context, page } = await open({ width: 1280, height: 800 })
  try {
    await page.goto(`${base}/en-GB/course/c1`)
    await page.waitForLoadState('networkidle')
    assert.equal(Math.round((await page.getByTestId('course-status-summary').boundingBox()).height), 40, '1280: 状态摘要应是 40px 高')
    assert.ok((await page.getByTestId('course-tabs').boundingBox()).height < 60, '1280: 页签行不应折成两行')
    for (const [tabId] of EDITOR_TABS) {
      await editorTabState(page, '1280', tabId)
    }
    await assertVersionsPane(page, '1280')

    await page.goto(`${base}/en-GB/course`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-overview-table-wrap').waitFor()
    const wrap = await page.getByTestId('course-overview-table-wrap').boundingBox()
    const actions = await page.getByRole('button', { name: /^Actions/ }).first().boundingBox()
    assert.ok(actions.x >= wrap.x - 1 && actions.x + actions.width <= wrap.x + wrap.width + 1, '1280: Actions 按钮应完整落在表格可见区内')
    await assertPageDoesNotScroll(page, 'course-overview-page', '1280 课程列表')
    await assertScrollable(page, 'course-overview-table-wrap', '1280 课程表格')
    await shot(page, 'course-overview-1280')
  } finally {
    await context.close()
  }
})

test('1000×800（<1100）：分栏纵向折叠，仍无横向溢出且页面不滚动', async () => {
  const { context, page } = await open({ width: 1000, height: 800 })
  try {
    await page.goto(`${base}/en-GB/course/c1`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-tab-versions').click()
    await page.waitForTimeout(200)
    await assertPageDoesNotScroll(page, 'course-editor-page', '1000 课程编辑')
    await assertTabsStickyAndPanelBounded(page, '1000 课程编辑')

    // <1240：板在上、列表在线上板下方（堆叠），无横向溢出。
    const liveBox = await page.getByTestId('versions-current-live').boundingBox()
    const listBox = await page.getByTestId('versions-list').boundingBox()
    assert.ok(listBox.y >= liveBox.y + liveBox.height - 1, `<1240 时列表应在线上板下方（live 底 ${liveBox.y + liveBox.height}，列表顶 ${listBox.y}）`)
    await shot(page, 'editor-versions-1000')

    await page.goto(`${base}/en-GB/course`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-overview-table-wrap').waitFor()
    const state = await scrollState(page, 'course-overview-page')
    assert.ok(state.document.scrollX <= state.viewport.width + 1, '1000 课程列表不应横向滚动')
    assert.ok(state.content.scrollX <= state.content.clientX + 1, '1000 课程列表 .content 不应横向溢出')
    await shot(page, 'course-overview-1000')
  } finally {
    await context.close()
  }
})

test('880×800（<900）：页面本体不滚动、无横向溢出（壳层 cardGrow 断点）', async () => {
  const { context, page } = await open({ width: 880, height: 800 })
  try {
    await page.goto(`${base}/en-GB/course/c1`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-tab-versions').click()
    await page.waitForTimeout(200)
    await assertPageDoesNotScroll(page, 'course-editor-page', '880 课程编辑')
    await assertTabsStickyAndPanelBounded(page, '880 课程编辑')

    await page.goto(`${base}/en-GB/course`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('course-overview-table-wrap').waitFor()
    const state = await scrollState(page, 'course-overview-page')
    assert.ok(state.document.scrollX <= state.viewport.width + 1, '880 课程列表不应横向滚动')
    assert.ok(state.content.scrollX <= state.content.clientX + 1, '880 课程列表 .content 不应横向溢出')
    await shot(page, 'course-overview-880')
  } finally {
    await context.close()
  }
})
