// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：常见问题「逐张审核」（FaqCardReview.tsx）。
// 锁住：从表格切到逐张审核（地址栏 view=review、card=<id>、rstate=）；队列按状态筛、每种状态的张数；1440×900 一屏、页面不滚动；
// 「没问题」带卡的版本和 Idempotency-Key、审完跳下一张；改了卡（手改或跟 AI 说，版本条变成 2 / 2）按钮变成「保存修改并标为已审」，
// 先 PUT 再审核（审的是保存后的版本）；「需要改」必须写为什么；「下线」两步确认后归档；别人先改了（409）提示并载入最新；
// 改动记录（谁、什么时候、改了哪些字段、备注）；只读角色（en-GB）不能改不能审。
// 运行：npm run test:e2e:helpdesk（本地跑，CI 不装浏览器）。截图：E2E_SHOTS=<目录> 时保存。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.E2E_SHOTS || null
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

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const F_REFUND = id(1)
const F_TRIAL = id(2)
const F_DEVICE = id(3)
const F_PRICE = id(4)

function card(faqId, patch) {
  return {
    id: faqId, key: faqId, type: 'answer', entry: true, category: 'payments_subscriptions', popular: false,
    questionEn: '', questionZh: '', answerEn: 'Answer.', answerZh: '答案。', keywords: [], signals: [], status: 'published', version: 3,
    createdBy: 'e1', updatedBy: 'e1', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-28T08:00:00Z', ...patch,
  }
}

const MIA = { id: id(91), name: 'Mia' }
const LEO = { id: id(92), name: 'Leo' }
const JACK = { id: 'e1', name: 'jack' }
const NONE = { status: 'unreviewed', faqVersion: null, note: null, by: null, at: null }

function initialItems() {
  return [
    { faq: card(F_REFUND, { popular: true, questionZh: '退款需要多久？', questionEn: 'How long does a refund take?', answerZh: '退款会在 3 个工作日内处理。', answerEn: 'Refunds are processed within 3 working days.' }), review: NONE },
    // 审过第 2 版，卡后来改到第 3 版：服务端给 unreviewed + faqVersion 2
    { faq: card(F_TRIAL, { questionZh: '怎么取消试用？', questionEn: 'How do I cancel my trial?', answerZh: '打开 设置 > 订阅，点「取消试用」。' }), review: { status: 'unreviewed', faqVersion: 2, note: null, by: MIA, at: '2026-10-20T09:00:00Z' } },
    { faq: card(F_DEVICE, { category: 'account_technical', questionZh: '可以在几台设备上使用？', questionEn: 'How many devices can I use?', answerZh: '最多 2 台设备。' }), review: { status: 'needs_change', faqVersion: 3, note: '现在是 3 台，不是 2 台', by: MIA, at: '2026-10-29T10:00:00Z' } },
    { faq: card(F_PRICE, { questionZh: '会员多少钱？', questionEn: 'How much is a plan?' }), review: { status: 'ok', faqVersion: 3, note: null, by: LEO, at: '2026-10-30T10:00:00Z' } },
  ]
}

const HISTORY = {
  [F_REFUND]: [
    { kind: 'card', at: '2026-10-28T08:00:00Z', by: LEO, action: 'update', version: 3, changes: [{ field: 'answerZh', before: '3 天', after: '退款会在 3 个工作日内处理。' }, { field: 'popular', before: false, after: true }] },
    { kind: 'placement', at: '2026-10-21T08:00:00Z', by: LEO, action: 'create', nodeKey: 'refund.request', primary: { before: null, after: true } },
    { kind: 'review', at: '2026-10-20T08:00:00Z', by: MIA, action: 'needs_change', version: 2, note: '答案太短' },
    { kind: 'card', at: '2026-10-01T00:00:00Z', by: null, action: 'create', version: 1, changes: [{ field: 'questionZh', before: null, after: '退款需要多久？' }] },
  ],
}

const ok = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message: code } }) })

function session(role) {
  return { employee: { employeeId: 'e1', loginEmail: 'jack@example.com', role, displayName: 'Jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
}

/** 一个页面一份假的服务端：记下写请求；审核 / 保存 / 下线之后状态跟着变。 */
async function open(urlPath, { role = 'ADMIN', viewport = { width: 1440, height: 900 }, conflictOnce = false } = {}) {
  let items = initialItems()
  let conflict = conflictOnce
  const calls = []
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const p = url.pathname
    const body = request.postData() ? JSON.parse(request.postData()) : null
    if (method !== 'GET') calls.push({ method, path: p, body, key: request.headers()['idempotency-key'] ?? null })
    if (p === '/api/session') return route.fulfill(ok(session(role)))
    if (p === '/api/helpdesk/faq-reviews') {
      const status = url.searchParams.get('status') ?? 'unreviewed'
      const q = url.searchParams.get('q') ?? ''
      const live = items.filter((item) => item.faq.status === 'published' && (!q || item.faq.questionZh.includes(q) || item.faq.questionEn.toLowerCase().includes(q.toLowerCase())))
      const counts = { unreviewed: 0, needs_change: 0, ok: 0 }
      for (const item of live) counts[item.review.status] += 1
      const list = live.filter((item) => status === 'all' || item.review.status === status)
      const reviews = Object.fromEntries(list.map((item) => [item.faq.id, item.review]))
      return route.fulfill(ok({ faqs: list.map((item) => item.faq), total: list.length, page: 1, pageSize: 50, counts, reviews }))
    }
    const one = p.match(/^\/api\/helpdesk\/faqs\/([^/]+)(?:\/(\w+))?$/)
    const item = one ? items.find((i) => i.faq.id === one[1]) : null
    if (one && one[2] === 'history') return route.fulfill(ok({ faqId: one[1], version: item.faq.version, review: item.review, history: HISTORY[one[1]] ?? [] }))
    if (one && one[2] === 'review') {
      if (conflict) {
        conflict = false
        item.faq = { ...item.faq, version: item.faq.version + 1, answerZh: `${item.faq.answerZh}（别人刚改过）` }
        return route.fulfill(fail(409, 'VERSION_CONFLICT'))
      }
      if (body.version !== item.faq.version) return route.fulfill(fail(409, 'VERSION_CONFLICT'))
      item.review = { status: body.status, faqVersion: body.version, note: body.note ?? null, by: JACK, at: '2026-10-31T15:00:00Z' }
      return route.fulfill(ok({ review: item.review, replayed: false }))
    }
    if (one && one[2] === 'archive') {
      item.faq = { ...item.faq, status: 'archived', version: item.faq.version + 1 }
      return route.fulfill(ok(item.faq))
    }
    if (one && !one[2] && one[1] === 'rewrite' && method === 'POST') {
      const draft = { questionZh: body.questionZh, answerZh: body.answerZh, questionEn: body.questionEn, answerEn: body.answerEn, category: body.category }
      if (body.lang === 'zh') draft.answerZh = `一般 ${body.answerZh}`
      else draft.answerEn = `Usually: ${body.answerEn}`
      return route.fulfill(ok({ draft, changed: ['answerZh'], model: 'deepseek', costUsd: 0.0001, warnings: [{ field: 'answerZh', kind: 'number', text: '3' }] }))
    }
    if (one && !one[2] && method === 'GET') return route.fulfill(item ? ok(item.faq) : fail(404, 'FAQ_NOT_FOUND'))
    if (one && !one[2] && method === 'PUT') {
      if (body.version !== item.faq.version) return route.fulfill(fail(409, 'VERSION_CONFLICT'))
      item.faq = { ...item.faq, ...body, keywords: [], version: item.faq.version + 1 }
      item.review = { ...item.review, status: 'unreviewed' }
      return route.fulfill(ok(item.faq))
    }
    if (p === '/api/helpdesk/faqs') {
      const live = items.filter((i) => i.faq.status === 'published').map((i) => i.faq)
      return route.fulfill(ok({ faqs: live, total: live.length, page: 1, pageSize: 10 }))
    }
    if (p === '/api/helpdesk/tickets') return route.fulfill(ok({ tickets: [], nextCursor: null, counts: {} }))
    return route.fulfill(ok({}))
  })
  await page.goto(`${base}${urlPath}`)
  return { page, calls, errors }
}

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const REVIEW = '/zh-CN/help-desk?tab=faqs&view=review'
const primary = (page) => page.locator('.hdReviewPrimary')
const waitCard = async (page, question) => {
  await page.locator('.hdReviewQueueCard[aria-current="true"]', { hasText: question }).waitFor()
  await page.locator('.hdFaqReviewPanel[aria-busy="false"]').waitFor()
}
const writes = (calls, re) => calls.filter((call) => re.test(call.path))

async function assertOneScreen(page) {
  const box = await page.evaluate(() => {
    const doc = document.scrollingElement
    const button = document.querySelector('.hdReviewPrimary, .hdFaqReviewPanel .hdReviewFooter')?.getBoundingClientRect()
    return { pageScroll: doc.scrollHeight - window.innerHeight, pageScrollX: doc.scrollWidth - window.innerWidth, bottom: button?.bottom ?? null, viewport: window.innerHeight }
  })
  assert.ok(box.pageScroll <= 1, `page scrolls by ${box.pageScroll}px`)
  assert.ok(box.pageScrollX <= 1, `page scrolls sideways by ${box.pageScrollX}px`)
  assert.ok(box.bottom !== null && box.bottom <= box.viewport, 'footer is on screen')
}

test('switching from the table: address bar, state chips with counts, popular card first, change log, one screen', async () => {
  const { page, errors } = await open('/zh-CN/help-desk?tab=faqs')
  await page.locator('.hdFaqTable tbody tr').first().waitFor()
  await page.getByRole('button', { name: '逐张审核' }).click()
  await waitCard(page, '退款需要多久？')
  assert.equal(new URL(page.url()).searchParams.get('view'), 'review')
  assert.equal(await page.locator('.hdReviewQueueCard').count(), 2)
  const chips = await page.locator('.hdFaqReviewStateBtn').allInnerTexts()
  assert.deepEqual(chips.map((text) => text.replace(/\s+/g, '')), ['未审核2', '需要改1', '已审核1', '全部4'])
  // 审完又改过的卡：标「改过，待复核」
  assert.match(await page.locator('.hdReviewQueueCard', { hasText: '怎么取消试用' }).innerText(), /改过，待复核/)
  assert.equal(await page.getByLabel('答案（中文）').inputValue(), '退款会在 3 个工作日内处理。')
  assert.match(await page.locator('.hdFaqReviewNow').innerText(), /还没有人审核过/)
  // 改动记录：谁、改了哪些字段、备注；没有名字的写「员工」
  const log = page.locator('.hdFaqHistory')
  await log.locator('li').nth(3).waitFor()
  assert.match(await log.locator('li').nth(0).innerText(), /Leo[\s\S]*改了这张卡（第 3 版）[\s\S]*改了：中文答案、热门/)
  assert.match(await log.locator('li').nth(1).innerText(), /Leo 把这张卡挂到了「refund.request」/)
  assert.match(await log.locator('li').nth(2).innerText(), /Mia[\s\S]*标为需要改[\s\S]*答案太短/)
  // 建卡不列字段；没有名字的写「员工」
  assert.match(await log.locator('li').nth(3).innerText(), /员工 建了这张卡/)
  assert.doesNotMatch(await log.locator('li').nth(3).innerText(), /改了：/)
  await assertOneScreen(page)
  await shot(page, 'faq-review-1440')
  // 表格切回来：审核参数去掉
  await page.getByRole('button', { name: '表格' }).click()
  await page.locator('.hdFaqTable').waitFor()
  assert.equal(new URL(page.url()).searchParams.get('view'), null)
  assert.deepEqual(errors, [])
  await page.close()
})

test('Looks fine: sends the card version with an Idempotency-Key, then moves to the next card and updates the counts', async () => {
  const { page, calls, errors } = await open(REVIEW)
  await waitCard(page, '退款需要多久？')
  assert.match(await primary(page).innerText(), /^没问题/)
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '已标为没问题' }).waitFor()
  const review = writes(calls, /\/review$/)
  assert.equal(review.length, 1)
  assert.deepEqual(review[0].body, { status: 'ok', version: 3 })
  assert.match(review[0].key, /^[0-9a-f-]{36}$/)
  await waitCard(page, '怎么取消试用？')
  await page.locator('.hdFaqReviewStateBtn', { hasText: '已审核2' }).waitFor()
  // Ctrl+Enter 也能按主按钮
  await page.getByLabel('答案（中文）').click()
  await page.keyboard.press('Control+Enter')
  await page.locator('.hdReviewEmpty', { hasText: '都审完了' }).waitFor()
  assert.equal(writes(calls, /\/review$/).length, 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('editing by hand or by telling AI makes a new version; the button saves first (PUT) and reviews the saved version', async () => {
  const { page, calls, errors } = await open(REVIEW)
  await waitCard(page, '退款需要多久？')
  await page.getByRole('button', { name: '短一点' }).click()
  await page.locator('.hdVersionCount', { hasText: '版本 2 / 2' }).waitFor()
  assert.equal(await page.getByLabel('答案（中文）').inputValue(), '一般 退款会在 3 个工作日内处理。')
  assert.match(await page.locator('.hdVersionNote').innerText(), /AI 按/)
  // AI 加了原卡和指令里都没有的数字：请员工核实
  await page.locator('.hdComposerWarnings', { hasText: '中文答案里出现了原卡和指令里都没有的数字「3」' }).waitFor()
  assert.match(await primary(page).innerText(), /保存修改并标为已审/)
  // 切回第一版：内容回去，按钮也回到「没问题」
  await page.getByRole('button', { name: '上一个版本' }).click()
  assert.equal(await page.getByLabel('答案（中文）').inputValue(), '退款会在 3 个工作日内处理。')
  assert.match(await primary(page).innerText(), /^没问题/)
  await page.getByRole('button', { name: '下一个版本' }).click()
  await page.getByLabel('答案（中文）').fill('一般 3 个工作日内到账。')
  await page.locator('.hdVersionCount', { hasText: '版本 3 / 3' }).waitFor()
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '已保存修改并标为已审' }).waitFor()
  const put = writes(calls, new RegExp(`/api/helpdesk/faqs/${F_REFUND}$`))
  assert.equal(put.length, 1)
  assert.equal(put[0].body.version, 3)
  assert.equal(put[0].body.answerZh, '一般 3 个工作日内到账。')
  const review = writes(calls, /\/review$/)
  assert.deepEqual(review[0].body, { status: 'ok', version: 4 })
  assert.ok(calls.indexOf(put[0]) < calls.indexOf(review[0]), 'saved before the review')
  await shot(page, 'faq-review-after-save')
  assert.deepEqual(errors, [])
  await page.close()
})

test('Needs changes requires a note; Take offline needs a second click and archives the card', async () => {
  const { page, calls, errors } = await open(REVIEW)
  await waitCard(page, '退款需要多久？')
  await page.getByRole('button', { name: '需要改', exact: true }).click()
  await page.getByRole('button', { name: /标为需要改/ }).click()
  await page.getByText('写一句哪里要改。').waitFor()
  assert.equal(writes(calls, /\/review$/).length, 0)
  await page.getByLabel('哪里要改').fill('  银行入账时间没写  ')
  await shot(page, 'faq-review-needs-change')
  await page.getByRole('button', { name: /标为需要改/ }).click()
  await page.locator('.hdReviewToast', { hasText: '已标为需要改' }).waitFor()
  assert.deepEqual(writes(calls, /\/review$/)[0].body, { status: 'needs_change', version: 3, note: '银行入账时间没写' })

  await waitCard(page, '怎么取消试用？')
  await page.getByRole('button', { name: '下线', exact: true }).click()
  await page.getByText('下线后用户就看不到这张卡了').waitFor()
  assert.equal(writes(calls, /\/archive$/).length, 0)
  await page.getByRole('button', { name: /确定下线/ }).click()
  await page.locator('.hdReviewToast', { hasText: '已下线' }).waitFor()
  const archive = writes(calls, /\/archive$/)
  assert.equal(archive.length, 1)
  assert.deepEqual(archive[0].body, { version: 3 })
  await page.locator('.hdFaqReviewStateBtn', { hasText: '全部3' }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

test('someone else changed the card first: says so and loads the latest card; the state chips filter the queue', async () => {
  const { page, calls, errors } = await open(REVIEW, { conflictOnce: true })
  await waitCard(page, '退款需要多久？')
  await primary(page).click()
  await page.locator('.hdReviewFootAlert').waitFor()
  await page.waitForFunction(() => document.querySelector('textarea[id$="answerZh"]')?.value.includes('别人刚改过'))
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '已标为没问题' }).waitFor()
  assert.deepEqual(writes(calls, /\/review$/).at(-1).body, { status: 'ok', version: 4 })

  await page.locator('.hdFaqReviewStateBtn', { hasText: '需要改' }).click()
  await waitCard(page, '可以在几台设备上使用？')
  assert.equal(new URL(page.url()).searchParams.get('rstate'), 'needs_change')
  assert.match(await page.locator('.hdFaqReviewNow').innerText(), /Mia[\s\S]*标为需要改[\s\S]*现在是 3 台/)
  assert.deepEqual(errors, [])
  await page.close()
})

test('a view-only role (COURSE_CREATOR) in en-GB can read cards and the log but cannot edit or review; 1280×800 stays one screen', async () => {
  const { page, calls, errors } = await open('/en-GB/help-desk?tab=faqs&view=review', { role: 'COURSE_CREATOR', viewport: { width: 1280, height: 800 } })
  await waitCard(page, 'How long does a refund take?')
  await page.getByText('You can view only.').waitFor()
  assert.equal(await primary(page).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Take offline' }).count(), 0)
  assert.equal(await page.locator('.hdComposer').count(), 0)
  assert.equal(await page.getByLabel('Answer (English)').getAttribute('readonly'), '')
  assert.match(await page.locator('.hdFaqHistory').innerText(), /edited this card \(version 3\)[\s\S]*Changed: Chinese answer, Popular/)
  await assertOneScreen(page)
  await shot(page, 'faq-review-readonly-1280')
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
  await page.close()
})
