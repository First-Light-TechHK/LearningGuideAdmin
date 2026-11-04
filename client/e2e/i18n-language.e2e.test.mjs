// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：BackOffice 每个模块只显示当前页面的语言。
// 检查的是浏览器最终渲染出来的文字，所以写死的文案、漏翻的 key、后端返回的句子、跟随浏览器语言的日期都会被抓到。
// 浏览器语言故意设成相反的语言。运行：node --test e2e/i18n-language.e2e.test.mjs（本地跑，CI 不装浏览器）。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
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

// 中文界面允许出现的英文：产品固定用词（AGENTS.md）和文件格式等专有名词。
const ZH_ALLOWED = ['Learning Guide BackOffice', 'Learning Guide', 'BackOffice', 'AI Tutor', 'HelpDesk', 'Help Desk', 'Portal', 'Improve Tutor', 'Stripe', 'Google Docs', 'Google', 'Wikimedia Commons', 'Markdown', 'OpenRouter', 'Lookup key', 'Word', 'Excel', 'LLM', 'FAQ', 'USD', 'AI', 'ID', 'URL', 'ZIP', 'JPG', 'PNG', 'WebM', 'MOV', 'MP4', 'MB', 'KB', 'zip', 'lgcourse', 'xlsx', 'csv', 'docx', 'px', 'mm', 'ss', 'EN', 'Top', 'en-GB', 'zh-CN', 'UTC']
const SWITCH_LABELS = ['Switch to English (UK)', '切换到简体中文']

function foreign(texts, locale, data) {
  return texts.filter((text) => {
    if (SWITCH_LABELS.includes(text)) return false
    let rest = text
    for (const value of [...data].sort((a, b) => b.length - a.length)) rest = rest.split(value).join(' ')
    if (locale === 'en-GB') return /[一-鿿]/.test(rest)
    for (const term of ZH_ALLOWED) rest = rest.split(term).join(' ')
    return /[A-Za-z]{2,}/.test(rest)
  })
}

async function rendered(page) {
  return page.evaluate(() => {
    const out = []
    const visible = (el) => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const box = el.getBoundingClientRect()
      return box.width > 1 && box.height > 1
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      const text = node.textContent?.trim()
      if (!text || !parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(parent.tagName)) continue
      if (parent.closest("[hidden], .sr-only, [aria-hidden='true']")) continue
      if (visible(parent)) out.push(text)
    }
    for (const el of document.querySelectorAll('[placeholder], [aria-label], [title]')) {
      if (!visible(el) || el.closest('.anticon, .ant-segmented')) continue
      for (const name of ['placeholder', 'aria-label', 'title']) {
        const value = el.getAttribute(name)?.trim()
        if (value) out.push(value)
      }
    }
    return out
  })
}

async function expectOneLanguage(page, locale, label) {
  await page.waitForTimeout(250)
  const found = foreign(await rendered(page), locale, DATA)
  assert.deepEqual(found, [], `${label} (${locale}) 出现了另一种语言的文字`)
}

const ok = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message } }) })

// 课程内容、人名是数据不是界面文案。
const DATA = ['Olive', 'olive@example.com', 'Modelling Life', '生命建模', 'CRS-1', 'LS-1', 'V1.0', 'L1', 'L2', 'name@company.com', 'name@example.com', '学习点一', 'Point one', 'Science', 'x.mp4', 'modelling-life', 'k1']
const SESSION = { employee: { employeeId: 'e1', loginEmail: 'olive@example.com', role: 'ADMIN', displayName: 'Olive', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
const WHEN = '2026-11-02T08:30:00.000Z'
const SUMMARY = { id: 'c1', code: 'CRS-1', slug: 'modelling-life', title: 'Modelling Life', subtitle: null, category: { id: 'cat', name: 'Science' }, learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'], lessonCount: 1, lifecycleStatus: 'PUBLISHED', liveStatus: 'ONLINE', liveVersionId: 'v1', liveVersionLabel: 'V1.0', liveVersionWentLiveAt: WHEN, hasDraft: true, trialEnabled: true, published: true, updatedAt: WHEN }
const lessonLocs = (language, title) => ({ language, title, description: title, textHtml: '<h1>x</h1>', videoAssetId: 'a1', video: { id: 'a1', originalName: 'x.mp4', size: 1024, mimeType: 'video/mp4', extension: 'mp4', createdAt: WHEN }, videoDurationSeconds: 60 })
const LESSON = { id: 'l1', code: 'LS-1', sortOrder: 0, localizations: [lessonLocs('en-GB', 'Modelling Life'), lessonLocs('zh-CN', '生命建模')], exhibits: [], readings: [], questions: [], applicationTest: null, learningPoints: [{ id: 'p1', language: 'en-GB', code: 'L1', title: 'Point one', source: 'MANUAL', timeSeconds: 10 }, { id: 'p2', language: 'zh-CN', code: 'L1', title: '学习点一', source: 'MANUAL', timeSeconds: 10 }], triggers: [] }
const DETAIL = {
  ...SUMMARY, defaultContentLanguage: 'en-GB', categoryId: 'cat', cover: null, localizations: [{ language: 'en-GB', title: 'Modelling Life', shortDescription: 'Modelling Life', overview: 'Modelling Life', whatYouLearn: [], provides: [] }, { language: 'zh-CN', title: '生命建模', shortDescription: '生命建模', overview: '生命建模', whatYouLearn: [], provides: [] }],
  lessons: [LESSON], plans: [], trialRows: [],
  completeness: { steps: { courseInformation: { complete: true, missing: [] }, content: { complete: false, missing: ['Lesson LS-1: title is required (en-GB)'], lessons: [{ lessonId: 'l1', code: 'LS-1', studyComplete: true, understandingComplete: false, missing: ['Lesson LS-1: application test needs a question'] }] }, trial: { complete: true, missing: [] } }, completedSteps: 2, canPublish: false, publishBlockers: [] },
}
const TRIAL = { enabled: true, learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'], rows: [{ lessonId: 'l1', code: 'LS-1', index: 1, title: 'Modelling Life', videoDurationSeconds: 60, inTrial: true, videoCutoffSeconds: 30, textCutoffLearningPointId: null, textCutoffCode: null, status: 'READY', learningPoints: [] }] }
const VERSIONS = [{ id: 'v1', versionNo: 1, versionLabel: 'V1.0', versionSeries: 1, versionMinor: 0, sourceEnvironment: null, sourceVersionLabel: null, wentLiveAt: WHEN, exportedAt: null, createdAt: WHEN, isLive: true }]
const HISTORY = { items: [{ id: 'h1', time: WHEN, operator: 'Olive', action: 'PUBLISH', versionNo: 1, detail: { versionLabel: 'V1.0' } }], total: 1, page: 1, pages: 1 }
const POPULAR = { items: [], publishedAt: WHEN, publishedBy: 'Olive' }
const BANNER = { enabled: false, courseId: null, localized: null, publishedAt: WHEN, publishedBy: 'Olive', invalid: false, course: null }
const KS_COURSE = { id: 'k1', title: 'Modelling Life', description: null, externalId: 'modelling-life', createdAt: WHEN, updatedAt: WHEN }

async function open(locale, overrides = {}) {
  const context = await browser.newContext({ locale: locale === 'zh-CN' ? 'en-US' : 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('pageerror', error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (overrides[path]) return route.fulfill(overrides[path](route))
    if (path === '/api/session') return route.fulfill(ok(SESSION))
    if (path === '/api/backoffice/courses/categories') return route.fulfill(ok([{ id: 'cat', name: 'Science' }]))
    if (path === '/api/backoffice/courses') return route.fulfill(ok({ courses: [SUMMARY], total: 1, page: 1, pages: 1, counts: { total: 1, draft: 0, published: 1, online: 1, hidden: 0, offline: 0, notPublished: 0 } }))
    if (path === '/api/backoffice/courses/c1') return route.fulfill(ok(DETAIL))
    if (path === '/api/backoffice/courses/c1/trial') return route.fulfill(ok(TRIAL))
    if (path === '/api/backoffice/courses/c1/versions') return route.fulfill(ok(VERSIONS))
    if (path === '/api/backoffice/courses/c1/history') return route.fulfill(ok(HISTORY))
    if (path === '/api/backoffice/operations/popular-courses') return route.fulfill(ok(POPULAR))
    if (path === '/api/backoffice/operations/discovery-banner') return route.fulfill(ok(BANNER))
    if (path === '/api/courses') return route.fulfill(ok([KS_COURSE]))
    if (path === '/api/courses/k1') return route.fulfill(ok({ ...KS_COURSE, pages: [] }))
    if (path === '/api/courses/k1/releases') return route.fulfill(ok([{ id: 'r1', versionTag: 'V1.0', revisionNotes: 'Modelling Life', createdAt: WHEN, isActive: true, isTestSelected: false, isEditing: false }]))
    if (path === '/api/sync/external-courses') return route.fulfill(ok([{ externalId: 'modelling-life', title: 'Modelling Life', localCourseId: 'k1', status: 'synced' }]))
    if (path === '/api/tags') return route.fulfill(ok([]))
    if (path === '/api/ai/tutors') return route.fulfill(ok([{ courseId: 'k1', title: 'Modelling Life', online: true, externalId: 'modelling-life', hasLiveRelease: true, available: true, blockedReason: null }]))
    if (path === '/api/ai/models') return route.fulfill(ok([]))
    if (path === '/api/ai/prompts') return route.fulfill(ok([]))
    return route.fulfill(fail(404, 'NOT_FOUND', '请求的资源不存在'))
  })
  return { context, page }
}

const PAGES = [
  ['课程列表', 'course'],
  ['课程编辑', 'course/c1'],
  ['运营位', 'operations'],
  ['Knowledge', 'knowledge'],
  ['AI Tutor', 'ai-tutor'],
  ['学员管理', 'student'],
  ['HelpDesk', 'help-desk'],
  ['设置', 'settings'],
  ['登录', 'sign-in'],
]

for (const locale of ['en-GB', 'zh-CN']) {
  test(`BackOffice ${locale}：每个模块都只显示当前语言，<html lang> 跟随`, async () => {
    const { context, page } = await open(locale)
    try {
      for (const [label, path] of PAGES) {
        await page.goto(`${base}/${locale}/${path}`)
        await page.waitForLoadState('networkidle')
        assert.equal(await page.evaluate(() => document.documentElement.lang), locale, label)
        await expectOneLanguage(page, locale, label)
      }
    } finally {
      await context.close()
    }
  })

  test(`课程编辑 ${locale}：内容、试看、版本各区块只显示当前语言，日期不跟浏览器语言`, async () => {
    const { context, page } = await open(locale)
    try {
      await page.goto(`${base}/${locale}/course/c1`)
      await page.waitForLoadState('networkidle')
      const tabs = await page.locator('section button, nav button, [role="tab"]').allInnerTexts()
      for (const name of locale === 'zh-CN' ? ['课程内容', '试看设置', '版本与发布'] : ['Course Content', 'Trial', 'Versions']) {
        const tab = page.getByRole('button', { name: new RegExp(name) }).first()
        if (await tab.count()) {
          await tab.click()
          await page.waitForTimeout(200)
          await expectOneLanguage(page, locale, `课程编辑/${name}`)
        } else {
          assert.fail(`没找到区块 ${name}，当前按钮：${tabs.join(' | ')}`)
        }
      }
    } finally {
      await context.close()
    }
  })
}

// Knowledge 的「同步」按钮：失败时后端的句子直接弹给用户。
async function syncKnowledge(page, locale) {
  await page.goto(`${base}/${locale}/knowledge`)
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').first().click()
  await page.getByRole('button', { name: locale === 'zh-CN' ? /同步课程标题/ : /Sync/ }).click()
}

test('后端中文报错：英文页面看到英文，没有译文时给通用提示，绝不显示中文', async () => {
  const known = await open('en-GB', { '/api/sync/structure': () => fail(404, 'NOT_FOUND', '课程不存在') })
  try {
    await syncKnowledge(known.page, 'en-GB')
    await known.page.getByText('The course does not exist.').first().waitFor()
    await expectOneLanguage(known.page, 'en-GB', 'Knowledge 报错')
  } finally {
    await known.context.close()
  }
  const unknown = await open('en-GB', { '/api/sync/structure': () => fail(500, 'INTERNAL_ERROR', '某个从没见过的后端报错') })
  try {
    await syncKnowledge(unknown.page, 'en-GB')
    await unknown.page.getByText('Something went wrong. Please try again.').first().waitFor()
    await expectOneLanguage(unknown.page, 'en-GB', 'Knowledge 未知报错')
  } finally {
    await unknown.context.close()
  }
})

test('后端英文报错：中文页面不显示英文句子', async () => {
  const { context, page } = await open('zh-CN', { '/api/sync/structure': () => fail(500, 'INTERNAL_ERROR', 'Connection terminated unexpectedly') })
  try {
    await syncKnowledge(page, 'zh-CN')
    await page.getByText('操作失败，请重试。').first().waitFor()
    await expectOneLanguage(page, 'zh-CN', 'Knowledge 英文报错')
  } finally {
    await context.close()
  }
})

test('课程加载失败：BackOffice 请求层同样按页面语言显示', async () => {
  const { context, page } = await open('en-GB', { '/api/backoffice/courses/c1': () => fail(404, 'NOT_FOUND', '课程不存在') })
  try {
    await page.goto(`${base}/en-GB/course/c1`)
    await page.getByText('Could not load course: The course does not exist.').first().waitFor()
    await expectOneLanguage(page, 'en-GB', '课程加载失败')
  } finally {
    await context.close()
  }
})

test('日期按页面语言显示，不跟浏览器语言', async () => {
  const en = await open('en-GB')
  try {
    await en.page.goto(`${base}/en-GB/operations`)
    await en.page.getByText(/Last published: \d+ Nov 2026, \d\d:\d\d/).first().waitFor()
  } finally {
    await en.context.close()
  }
  const zh = await open('zh-CN')
  try {
    await zh.page.goto(`${base}/zh-CN/operations`)
    await zh.page.getByText(/最近发布: 2026年11月\d+日/).first().waitFor()
  } finally {
    await zh.context.close()
  }
})

test('页面崩溃时的错误页也是当前语言', async () => {
  const broken = () => ok({ ...DETAIL, completeness: undefined })
  const en = await open('en-GB', { '/api/backoffice/courses/c1': broken })
  try {
    await en.page.goto(`${base}/en-GB/course/c1`)
    await en.page.getByRole('button', { name: 'Reload' }).waitFor()
    await en.page.getByText('This page could not be displayed').waitFor()
  } finally {
    await en.context.close()
  }
  const zh = await open('zh-CN', { '/api/backoffice/courses/c1': broken })
  try {
    await zh.page.goto(`${base}/zh-CN/course/c1`)
    await zh.page.getByText('页面渲染异常').waitFor()
  } finally {
    await zh.context.close()
  }
})

test('语言切换：点一下整页换语言，语言名称也跟着换', async () => {
  const { context, page } = await open('en-GB')
  try {
    await page.goto(`${base}/en-GB/course`)
    await page.getByRole('cell', { name: 'English, Chinese' }).first().waitFor()
    await page.getByRole('button', { name: '切换到简体中文' }).click()
    await page.waitForURL(/\/zh-CN\/course/)
    await page.getByRole('cell', { name: '英文, 中文' }).first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN')
    await expectOneLanguage(page, 'zh-CN', '切换后的课程列表')
  } finally {
    await context.close()
  }
})
