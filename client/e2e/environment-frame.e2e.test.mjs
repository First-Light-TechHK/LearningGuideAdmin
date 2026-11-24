// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：环境墙 / 钥石 / 版本语法 / 发布流程。
// 运行：node --test e2e/environment-frame.e2e.test.mjs（本地跑，CI 不装浏览器）。
// 截图：设置 FRAME_SHOTS=<目录> 时保存视口截图（减少动效，deviceScaleFactor 2）。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.FRAME_SHOTS || null
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
const MEDIA_LIMITS = { imageBytes: 10485760, videoBytes: 1073741824, audioBytes: 209715200, pdfBytes: 52428800, modelBytes: 104857600, chunkSize: 8388608 }

const lessonLocs = (language, title) => ({ language, title, description: title, textHtml: '<h1>x</h1>', videoAssetId: 'a1', video: { id: 'a1', originalName: 'x.mp4', size: 1024, mimeType: 'video/mp4', extension: 'mp4', createdAt: WHEN }, videoDurationSeconds: 60 })
const LESSON = (n) => ({
  id: `l${n}`, code: `LS-${n}`, sortOrder: n - 1,
  localizations: [lessonLocs('en-GB', `Lesson ${n}`), lessonLocs('zh-CN', `第 ${n} 课`)],
  exhibits: [], readings: [], questions: [], applicationTest: null, triggers: [],
  learningPoints: [{ id: `p${n}`, language: 'en-GB', code: 'L1', title: 'Point one', source: 'MANUAL', timeSeconds: 10 }],
})
const LESSONS = Array.from({ length: 12 }, (_, index) => LESSON(index + 1))

const v = (versionNo, series, minor, label, extra = {}) => ({
  id: `v${versionNo}`, versionNo, versionLabel: label, versionSeries: series, versionMinor: minor,
  sourceEnvironment: null, sourceVersionLabel: null, wentLiveAt: WHEN, publishedBy: 'Olive', exportedAt: null, createdAt: WHEN, isLive: false, ...extra,
})
const sandboxVersions = () => [
  v(1, 1, 1, '1.1', { exportedAt: '2026-06-14T08:00:00.000Z' }),
  v(2, 2, 1, '2.1'),
  v(3, 2, 2, '2.2', { exportedAt: '2026-08-02T08:00:00.000Z' }),
  v(4, 3, 1, '3.1'),
  v(5, 3, 2, '3.2'),
  v(6, 3, 3, '3.3', { sourceEnvironment: null, sourceVersionLabel: '3.1' }),
  v(7, 3, 4, '3.4', { exportedAt: '2026-10-05T08:00:00.000Z' }),
  v(8, 4, 1, '4.1'),
  v(9, 4, 2, '4.2', { isLive: true }),
]
const productionVersions = () => [
  v(1, 1, 1, 'Version 1', { sourceEnvironment: 'Sandbox', sourceVersionLabel: '1.1' }),
  v(2, 1, 2, 'Version 2', { sourceVersionLabel: '1' }),
  v(3, 1, 3, 'Version 3', { sourceEnvironment: 'Sandbox', sourceVersionLabel: '3.4' }),
  v(4, 1, 4, 'Version 4', { sourceEnvironment: 'Sandbox', sourceVersionLabel: '4.2', isLive: true }),
]

function makeState(kind) {
  const production = kind === 'production'
  return {
    kind,
    versions: production ? productionVersions() : sandboxVersions(),
    hasDraft: true,
    draftSource: production ? { type: 'IMPORT', env: 'Sandbox', label: '4.2' } : null,
    liveStatus: 'ONLINE',
    publishCalls: 0,
    exportReady: false,
    versionsRequests: 0,
  }
}

const detail = (state) => ({
  id: 'c1', code: 'C001', slug: 'modelling-life', subtitle: null, category: { id: 'cat', name: 'Science' },
  learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'], lifecycleStatus: 'PUBLISHED', liveStatus: state.liveStatus,
  liveVersionId: state.versions.find((x) => x.isLive)?.id ?? null, hasDraft: state.hasDraft, trialEnabled: true,
  draftSourceType: state.hasDraft ? state.draftSource?.type ?? null : null,
  draftSourceEnvironment: state.hasDraft ? state.draftSource?.env ?? null : null,
  draftSourceVersionLabel: state.hasDraft ? state.draftSource?.label ?? null : null,
  defaultContentLanguage: 'en-GB', categoryId: 'cat', cover: null,
  localizations: [
    { language: 'en-GB', title: 'Practical Statistics for Decisions', shortDescription: 'Practical Statistics', overview: 'Practical Statistics', whatYouLearn: ['Understand statistics'], provides: ['Video lessons'] },
    { language: 'zh-CN', title: '决策统计实务', shortDescription: '决策统计实务', overview: '决策统计实务', whatYouLearn: [], provides: [] },
  ],
  lessons: LESSONS, plans: [], trialRows: [],
  completeness: {
    steps: {
      courseInformation: { complete: true, missing: [] },
      content: { complete: false, missing: ['Lesson LS-6: study is required'], lessons: [] },
      trial: { complete: true, missing: [] },
    },
    completedSteps: 2, canPublish: true, publishBlockers: [], publishBlockerCodes: [],
    incompleteLessons: [{ lessonId: 'l6', code: 'LS-6', position: 6, parts: ['STUDY'] }],
  },
})

const TRIAL = {
  enabled: true, learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'],
  rows: LESSONS.map((lesson, index) => ({ lessonId: lesson.id, code: lesson.code, index: index + 1, title: `Lesson ${index + 1}`, videoDurationSeconds: 60, inTrial: index < 2, videoCutoffSeconds: 30, textCutoffLearningPointId: null, textCutoffCode: null, status: 'READY', learningPoints: [] })),
}
const HISTORY = {
  items: [
    { id: 'h3', time: WHEN, operator: 'Olive', action: 'PUBLISH', versionNo: 9, detail: { versionLabel: '4.2' } },
    { id: 'h2', time: '2026-10-05T08:00:00.000Z', operator: 'Olive', action: 'EXPORT', versionNo: 7, detail: { versionLabel: '3.4' } },
    { id: 'h1', time: '2026-09-01T08:00:00.000Z', operator: 'Mei', action: 'PUBLISH', versionNo: 7, detail: { versionLabel: '3.4' } },
  ],
  total: 3, page: 1, pages: 1,
}
const listRow = (state) => ({
  id: 'c1', code: 'C001', slug: 'modelling-life', title: 'Practical Statistics for Decisions', subtitle: null, category: { id: 'cat', name: 'Science' },
  learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'], lessonCount: 12, lifecycleStatus: 'PUBLISHED', liveStatus: state.liveStatus,
  liveVersionId: state.versions.find((x) => x.isLive)?.id ?? null, liveVersionLabel: state.versions.find((x) => x.isLive)?.versionLabel ?? null,
  liveVersionWentLiveAt: WHEN, hasDraft: state.hasDraft, trialEnabled: true, published: true, updatedAt: WHEN,
})
const otherRow = (n) => ({ ...listRow({ liveStatus: n % 2 ? 'ONLINE' : 'HIDDEN', versions: [], hasDraft: n % 3 === 0 }), id: `c${n}`, code: `C00${n}`, slug: `course-${n}`, title: `Course ${n}`, liveVersionLabel: n % 4 === 0 ? null : `Version ${n}`, published: n % 4 !== 0, liveStatus: n % 4 === 0 ? null : n % 2 ? 'ONLINE' : 'HIDDEN' })

function nextLabel(state) {
  const last = [...state.versions].sort((a, b) => b.versionNo - a.versionNo)[0]
  if (state.kind === 'production') return { series: 1, minor: last.versionMinor + 1, label: `Version ${last.versionMinor + 1}` }
  if (last.exportedAt) return { series: last.versionSeries + 1, minor: 1, label: `${last.versionSeries + 1}.1` }
  return { series: last.versionSeries, minor: last.versionMinor + 1, label: `${last.versionSeries}.${last.versionMinor + 1}` }
}

/** kind: 'sandbox' | 'production' | 'neutral'（health 说 DEV）。 */
async function open(kind, viewport, locale = 'en-GB', options = {}) {
  const context = await browser.newContext({ locale, timezoneId: 'Asia/Shanghai', viewport, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => console.error('pageerror', error.message))
  const state = makeState(kind === 'neutral' ? 'sandbox' : kind)
  if (options.noDraft) state.hasDraft = false
  if (options.liveStatus) state.liveStatus = options.liveStatus
  if (options.clipboard === 'granted') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  if (options.clipboard === 'missing') await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }))
  const appEnv = { sandbox: 'SANDBOX', production: 'PROD', neutral: 'DEV' }[kind]
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/session') return route.fulfill(ok(SESSION))
    if (path === '/api/health') return route.fulfill(ok({ status: 'ok', service: 'learning-guide-admin', environment: appEnv }))
    if (path === '/api/backoffice/environment') {
      return route.fulfill(ok({ label: state.kind === 'production' ? 'Production' : 'Sandbox', publicSiteUrl: 'https://example.com', versionNumberingMode: state.kind, stripeConfigured: false }))
    }
    if (path === '/api/backoffice/courses/categories') return route.fulfill(ok(CATEGORIES))
    if (path === '/api/backoffice/courses/media-limits') return route.fulfill(ok(MEDIA_LIMITS))
    if (path === '/api/backoffice/courses') {
      const courses = [listRow(state), ...[2, 3, 4, 5, 6].map(otherRow)]
      return route.fulfill(ok({ courses, total: 6, page: 1, pages: 1, counts: { total: 6, draft: 2, published: 5, online: 3, hidden: 2, offline: 0, notPublished: 1 } }))
    }
    if (path === '/api/backoffice/courses/c1') return route.fulfill(ok(detail(state)))
    if (path === '/api/backoffice/courses/c1/trial') return route.fulfill(ok(TRIAL))
    if (path === '/api/backoffice/courses/c1/versions') { state.versionsRequests += 1; return route.fulfill(ok(state.versions)) }
    if (path === '/api/backoffice/courses/c1/history') return route.fulfill(ok(HISTORY))
    if (path === '/api/backoffice/courses/c1/publish' && method === 'POST') {
      state.publishCalls += 1
      const next = nextLabel(state)
      const last = [...state.versions].sort((a, b) => b.versionNo - a.versionNo)[0]
      state.versions = state.versions.map((x) => ({ ...x, isLive: false }))
      state.versions.push(v(last.versionNo + 1, next.series, next.minor, next.label, { isLive: true, sourceEnvironment: state.draftSource?.env ?? null, sourceVersionLabel: state.draftSource?.label ?? null }))
      state.hasDraft = false
      state.draftSource = null
      return route.fulfill(ok({ ok: true }))
    }
    if (path === '/api/backoffice/courses/c1/delete-draft' && method === 'POST') { state.hasDraft = false; return route.fulfill(ok({ ok: true })) }
    if (path === '/api/backoffice/courses/c1/live-status' && method === 'POST') { state.liveStatus = JSON.parse(request.postData() || '{}').status || state.liveStatus; return route.fulfill(ok({ ok: true })) }
    if (path === '/api/backoffice/courses/c1/export' && method === 'POST') return route.fulfill(ok({ jobId: 'j1' }))
    if (path === '/api/backoffice/courses/export/j1') return route.fulfill(ok({ status: 'READY', progress: 100 }))
    if (path === '/api/backoffice/courses/export/j1/download') return route.fulfill({ status: 200, contentType: 'application/zip', body: 'zip' })
    return route.fulfill(fail(404, 'NOT_FOUND', '请求的资源不存在'))
  })
  return { context, page, state }
}

async function shot(page, name) {
  if (!SHOTS) return
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(350)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const RULE = { sandbox: 'rgb(91, 42, 134)', production: 'rgb(142, 47, 31)', neutral: 'rgb(102, 105, 96)' }
const NAME = { sandbox: /sandbox/i, production: /production/i, neutral: /dev/i }

for (const kind of ['sandbox', 'production', 'neutral']) {
  test(`${kind}: wall colour, keystone and no old badge`, async () => {
    const { context, page } = await open(kind, { width: 1440, height: 900 })
    try {
      await page.goto(`${base}/en-GB/course`)
      await page.getByTestId('course-overview-table-wrap').waitFor()
      const keystone = page.getByTestId('env-keystone')
      await keystone.waitFor()
      assert.match(await keystone.innerText(), NAME[kind])
      assert.equal(await page.locator('.shell').getAttribute('data-env'), kind)
      assert.equal(await page.locator('.envWall').evaluate((el) => getComputedStyle(el).borderTopColor), RULE[kind])
      assert.equal(await page.locator('.headerBrand span[title]').count(), 0, 'old environment badge is gone')
      const dashed = await page.locator('.envWall').evaluate((el) => getComputedStyle(el, '::before').borderTopStyle)
      assert.equal(dashed, kind === 'sandbox' ? 'dashed' : kind === 'production' ? 'solid' : 'solid')
      await shot(page, `${kind}-list-1440`)
    } finally {
      await context.close()
    }
  })
}

const SIZES = [[1440, 900], [1280, 800]]

async function openVersions(page, tab = 'versions') {
  await page.goto(`${base}/${page.locale ?? 'en-GB'}/course/c1`)
  await page.getByTestId('course-tab-versions').waitFor()
  await page.getByTestId(`course-tab-${tab}`).click()
  await page.getByTestId(tab === 'versions' ? 'versions-section' : 'course-tab-panel-content').waitFor()
  await page.waitForTimeout(250)
}

for (const kind of ['sandbox', 'production']) {
  for (const [width, height] of SIZES) {
    test(`${kind} ${width}: list, content, versions, publish confirm, after publish`, async () => {
      const { context, page, state } = await open(kind, { width, height })
      try {
        await page.goto(`${base}/en-GB/course`)
        await page.getByTestId('course-overview-table-wrap').waitFor()
        await shot(page, `${kind}-list-${width}`)

        // The Actions button of the first row sits whole inside the table area (no clipped column).
        const wrap = await page.getByTestId('course-overview-table-wrap').boundingBox()
        const actions = await page.getByRole('button', { name: /^Actions/ }).first().boundingBox()
        assert.ok(actions && wrap && actions.x >= wrap.x - 1 && actions.x + actions.width <= wrap.x + wrap.width + 1, `${width}: Actions button inside the table (button ${actions?.x}+${actions?.width}, table ${wrap?.x}+${wrap?.width})`)
        assert.ok(actions.width >= 70, `${width}: Actions button is not squeezed (${actions.width}px)`)
        assert.ok(await page.getByRole('button', { name: 'Import course ▾' }).isVisible(), 'Import says what it imports')

        await openVersions(page, 'content')
        await shot(page, `${kind}-course-content-${width}`)
        // one status summary line of 40 px and one tab row, at every width
        assert.equal(Math.round((await page.getByTestId('course-status-summary').boundingBox()).height), 40, `${width}: summary is 40px`)
        assert.ok((await page.getByTestId('course-tabs').boundingBox()).height < 60, `${width}: tabs stay on one row`)
        assert.equal(await page.getByTestId('course-tab-versions').locator('.course-ui-tabMark').count(), 0, 'Versions tab has no tick')

        await openVersions(page)
        // the next-publish row and the lamp exist in both environments
        assert.equal(await page.getByTestId('version-next').count(), 1)
        assert.equal(await page.locator('.course-ui-vTable .course-ui-node.isLamp').count(), 1)
        assert.equal(await page.getByTestId('versions-not-visible').count(), 0, 'no "users cannot see" note while Online')
        assert.equal(Math.round((await page.getByTestId('course-status-summary').boundingBox()).height), 40, `${width}: summary is 40px on Versions`)
        // the Live tag is whole and visible inside its cell
        const tag = page.locator('.course-ui-liveTag').first()
        assert.equal((await tag.innerText()).trim(), 'Live')
        const tagBox = await tag.boundingBox()
        const cellBox = await tag.locator('xpath=ancestor::td[1]').boundingBox()
        assert.ok(tagBox.width >= 24 && tagBox.x + tagBox.width <= cellBox.x + cellBox.width + 1, `${width}: Live tag inside its cell`)
        // row actions are whole: "Restore" is not cut to "Rest"
        const restore = page.getByRole('button', { name: 'Restore' }).first()
        assert.ok(await restore.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('td').getBoundingClientRect().right + 1), `${width}: Restore fully visible`)
        // the dashed and the solid tether turn at different x, so they never share a stretch
        const turns = await page.evaluate(() => ['isDraft', 'isLive'].map((name) => {
          const d = document.querySelector(`.course-ui-tethers path.${name}`)?.getAttribute('d') ?? ''
          const m = d.match(/H[\d.]+Q([\d.]+)/)
          return m ? Number(m[1]) : null
        }))
        if (turns[0] !== null && turns[1] !== null) assert.ok(Math.abs(turns[0] - turns[1]) >= 4, `${width}: tethers turn apart (${turns})`)
        // folded old versions are plain (italic is reserved for the next publish)
        const folds = page.locator('[data-testid^="version-fold-"]')
        if (await folds.count()) assert.equal(await folds.first().locator('td').nth(1).evaluate((el) => getComputedStyle(el).fontStyle), 'normal')
        // History uses the same table, one version name, no internal number
        assert.equal(await page.locator('[data-testid="versions-history"] table.course-ui-vTable').count(), 1)
        assert.doesNotMatch(await page.getByTestId('versions-history').innerText(), /· v\d/)
        assert.match(await page.getByTestId('versions-history').innerText(), /Version 4\.2/)
        await shot(page, `${kind}-versions-${width}`)

        await page.getByTestId('publish-open').click()
        await page.getByRole('dialog').waitFor()
        await page.waitForTimeout(350)
        assert.match(await page.getByRole('dialog').innerText(), kind === 'sandbox' ? /Publish as Version 4\.3\?/ : /Publish as Version 5\?/)
        await shot(page, `${kind}-publish-confirm-${width}`)

        await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click()
        await page.getByText('Published successfully.').waitFor()
        await page.waitForTimeout(900)
        assert.equal(state.publishCalls, 1)
        assert.equal(await page.getByTestId('version-next').count(), 0)
        assert.equal(await page.getByTestId('publish-open').getAttribute('aria-disabled'), 'true')
        assert.match(await page.getByTestId('versions-current-draft').innerText(), kind === 'sandbox' ? /Version 4\.4/ : /Version 6/)
        await shot(page, `${kind}-after-publish-${width}`)
      } finally {
        await context.close()
      }
    })
  }
}

for (const reduced of [false, true]) {
  test(`publish motion (${reduced ? 'reduced motion' : 'motion allowed'})`, async () => {
    const { context, page } = await open('sandbox', { width: 1440, height: 900 })
    try {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
      await openVersions(page)
      await page.getByTestId('publish-open').click()
      await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click()
      const grid = page.locator('.course-ui-vGrid')
      if (reduced) {
        await page.waitForFunction(() => document.querySelector('.course-ui-vGrid')?.getAttribute('data-publish-motion') === 'done', null, { timeout: 1500 })
      } else {
        await page.waitForFunction(() => document.querySelector('.course-ui-vGrid')?.getAttribute('data-publish-motion') === 'running', null, { timeout: 1500, polling: 'raf' })
        assert.ok(await page.evaluate(() => document.getAnimations().length) > 0, 'animations are running')
        await page.waitForFunction(() => document.querySelector('.course-ui-vGrid')?.getAttribute('data-publish-motion') === 'done', null, { timeout: 1500 })
      }
      assert.equal(await grid.getAttribute('data-publish-motion'), 'done')
      assert.equal(await page.locator('.course-ui-motion').count(), 0, 'overlay removed')
      assert.equal(await page.locator('.course-ui-vTable .course-ui-node.isLamp').count(), 1)
    } finally {
      await context.close()
    }
  })
}

test('offline live version: says users cannot see it and the lamp is unlit (English and Chinese)', async () => {
  for (const [locale, note, legend] of [['en-GB', /Users cannot see this course now/, /not visible to users/], ['zh-CN', /用户现在看不到这门课/, /用户看不到/]]) {
    const { context, page } = await open('sandbox', { width: 1280, height: 800 }, locale, { liveStatus: 'OFFLINE' })
    try {
      page.locale = locale
      await openVersions(page)
      assert.match(await page.getByTestId('versions-not-visible').innerText(), note)
      assert.equal(await page.locator('.course-ui-legend .course-ui-node.isLamp.isUnlit').count(), 1, 'legend lamp is unlit')
      assert.match(await page.locator('.course-ui-legend').innerText(), legend)
      assert.equal(await page.locator('.course-ui-vTable .course-ui-node.isLamp.isUnlit').count(), 1, 'row lamp is unlit')
      if (locale === 'en-GB') await shot(page, 'sandbox-versions-offline-1280')
    } finally {
      await context.close()
    }
  }
})

test('dialogs: focus moves in, Tab stays inside, focus returns to the trigger', async () => {
  const { context, page } = await open('sandbox', { width: 1440, height: 900 })
  try {
    await openVersions(page)
    const trigger = page.getByTestId('publish-open')
    await trigger.focus()
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true, 'focus is inside the dialog on open')
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true, `Tab ${i + 1} stays inside`)
    }
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true, 'Shift+Tab stays inside')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, 'focus returns to the trigger')
  } finally {
    await context.close()
  }
})

test('copy course id: shows Copied for a moment, and says nothing when the clipboard is missing', async () => {
  let session = await open('sandbox', { width: 1440, height: 900 }, 'en-GB', { clipboard: 'granted' })
  try {
    await session.page.goto(`${base}/en-GB/course/c1`)
    await session.page.locator('.course-ui-copy').click()
    await session.page.locator('.course-ui-copied').waitFor()
    assert.equal((await session.page.locator('.course-ui-copied').innerText()).trim(), 'Copied')
    assert.equal(await session.page.evaluate(() => navigator.clipboard.readText()), 'C001')
    await session.page.locator('.course-ui-copied').waitFor({ state: 'detached', timeout: 3000 })
  } finally {
    await session.context.close()
  }
  session = await open('sandbox', { width: 1440, height: 900 }, 'en-GB', { clipboard: 'missing' })
  try {
    await session.page.goto(`${base}/en-GB/course/c1`)
    await session.page.locator('.course-ui-copy').click()
    await session.page.waitForTimeout(300)
    assert.equal(await session.page.locator('.course-ui-copied').count(), 0)
  } finally {
    await session.context.close()
  }
})

test('list dialogs wear the same paper, serif title and double rule as the version dialogs', async () => {
  const { context, page } = await open('sandbox', { width: 1440, height: 900 })
  try {
    await page.goto(`${base}/en-GB/course`)
    await page.getByTestId('course-overview-table-wrap').waitFor()
    await page.getByRole('button', { name: 'Create course', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.ok(await dialog.evaluate((el) => el.classList.contains('course-ui-dialog')))
    assert.equal(await page.locator('.modalBackdrop.course-ui-scrim').count(), 1)
    assert.match(await page.locator('#create-course-title').evaluate((el) => getComputedStyle(el).fontFamily), /Cormorant|serif/i)
    assert.equal(await dialog.locator('.course-ui-dRule').count(), 1)
  } finally {
    await context.close()
  }
})

test('keystone waits for health without saying Unknown, then names the environment', async () => {
  const { context, page } = await open('sandbox', { width: 1440, height: 900 })
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    await page.route((url) => url.pathname === '/api/health', async (route) => {
      await gate
      await route.fulfill(ok({ status: 'ok', service: 'learning-guide-admin', environment: 'SANDBOX' }))
    })
    await page.goto(`${base}/en-GB/course`)
    await page.getByTestId('course-overview-table-wrap').waitFor()
    const keystone = page.getByTestId('env-keystone')
    assert.doesNotMatch(await keystone.innerText(), /unknown/i, 'no Unknown while health is pending')
    assert.equal(await page.locator('.shell').getAttribute('data-env'), 'neutral')
    release()
    await page.waitForFunction(() => /sandbox/i.test(document.querySelector('[data-testid="env-keystone"]')?.textContent ?? ''))
    assert.equal(await page.locator('.shell').getAttribute('data-env'), 'sandbox')
  } finally {
    await context.close()
  }
})

test('extras: neutral list, export confirm, Chinese versions, stacked versions', async () => {
  let session = await open('neutral', { width: 1440, height: 900 })
  try {
    await session.page.goto(`${base}/en-GB/course`)
    await session.page.getByTestId('course-overview-table-wrap').waitFor()
    await shot(session.page, 'neutral-list-1440')
  } finally {
    await session.context.close()
  }

  session = await open('sandbox', { width: 1440, height: 900 })
  try {
    await openVersions(session.page)
    await session.page.getByTestId('export-open').click()
    await session.page.getByRole('dialog').waitFor()
    await session.page.waitForTimeout(350)
    await shot(session.page, 'sandbox-export-confirm-1440')
  } finally {
    await session.context.close()
  }

  session = await open('sandbox', { width: 1440, height: 900 }, 'zh-CN')
  try {
    session.page.locale = 'zh-CN'
    await openVersions(session.page)
    await shot(session.page, 'sandbox-versions-zh-1440')
  } finally {
    await session.context.close()
  }

  session = await open('sandbox', { width: 1000, height: 800 })
  try {
    await openVersions(session.page)
    await shot(session.page, 'sandbox-versions-1000')
  } finally {
    await session.context.close()
  }
})
