// 浏览器 E2E（真 Chromium + Vite dev server，API 全部在浏览器里假装）：FAQ 候选「卡片审核」视图。
// 锁住：切到卡片审核（地址栏 view=cards、review=<id>）、AI 建议与四种动作、相似卡同位置在前、
// 新卡必须选位置（建议的位置或整棵树）且接受时带 placementNodeId、标记失效要二次确认并可挪问法、
// 驳回 / 合并 / 不改动、批准后跳到队列下一条、VIEW 角色只读、三栏在 1440 宽不横向溢出。
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
const C_UPDATE = id(1)
const C_NEW = id(2)
const C_RETIRE = id(3)
const F_REFUND = id(101)
const F_REFUND_FAIL = id(102)
const F_TRIAL = id(103)
const F_DEVICE = id(104)
const F_DEVICE_OLD = id(105)
const N_REFUND = id(201)
const N_REFUND_REQ = id(202)
const N_REFUND_LATE = id(203)
const N_ACCOUNT = id(204)
const N_DEVICE = id(205)
const N_RULES = id(206)
const N_RULES_DEVICES = id(207)
const NEW_CARD = id(301)

function candidate(cid, patch) {
  return {
    id: cid, status: 'new', suggestion: 'new_faq', origin: 'mining', topic: '', proposedQuestion: '', labelSource: 'model',
    category: 'payments_subscriptions', locale: 'zh-CN', turnCount: 3, examples: [], sourceMix: {}, answerSources: [],
    relatedNodeId: null, relatedScore: null, parentNodeId: null, shownNodeId: null, ticketId: null,
    firstSeenAt: '2026-10-24T08:00:00Z', lastSeenAt: '2026-10-30T21:10:00Z', reason: null, reasonNote: null,
    acceptedAs: null, acceptedFaqId: null, mergedInto: null, decidedBy: null, decidedAt: null, actionKey: null,
    version: 2, createdBy: null, createdAt: '2026-10-24T08:00:00Z', updatedAt: '2026-10-30T21:10:00Z', ...patch,
  }
}

const path = (...items) => items.map(([key, labelZh, labelEn]) => ({ key, labelZh, labelEn }))
const P_REFUND = ['refund', '退款', 'Refunds']
const P_REFUND_REQ = ['refund.request', '申请退款', 'Request a refund']
const P_REFUND_LATE = ['refund.late', '退款没到账', 'Refund not received']
const P_RULES = ['rules.devices', '设备规则', 'Device rules']
const P_RULES_LIMIT = ['rules.devices.limit', '同时登录的设备数', 'Devices signed in at once']

function initialRows() {
  return [
    candidate(C_UPDATE, {
      suggestion: 'update_faq', topic: '退款到账时间', proposedQuestion: '退款多久能到账？', turnCount: 9, relatedNodeId: F_REFUND,
      examples: [
        { turnId: 't1', text: '退款申请通过了，钱多久能回到卡里', locale: 'zh-CN', reasons: ['not_helpful'] },
        { turnId: 't2', text: 'how long does a refund take to show up on my card', locale: 'en-GB', reasons: ['ticket_after_chat'] },
        { turnId: 't3', text: '我已经等了 10 天还没到账，联系 <email> 也没回', locale: 'zh-CN', reasons: ['handover'] },
      ],
      sourceMix: { not_helpful: 5, ticket_after_chat: 3, handover: 1 },
    }),
    candidate(C_NEW, {
      suggestion: 'new_faq', topic: '换设备登录', proposedQuestion: '换了新手机怎么登录原来的账号？', turnCount: 6, category: 'account_technical',
      examples: [
        { turnId: 't4', text: '换了新手机登不上原来的账号了', locale: 'zh-CN', reasons: ['no_match'] },
        { turnId: 't5', text: '換咗新電話點樣登入', locale: 'zh-TW', reasons: ['no_match'] },
      ],
      sourceMix: { no_match: 6 },
    }),
    candidate(C_RETIRE, {
      suggestion: 'retire_faq', topic: '旧版设备上限', proposedQuestion: '最多可以在几台设备上登录？', turnCount: 2, category: 'account_technical',
      relatedNodeId: F_DEVICE_OLD, examples: [{ turnId: 't6', text: '几台设备能同时用', locale: 'zh-CN', reasons: ['not_helpful'] }],
      sourceMix: { not_helpful: 2 },
    }),
  ]
}

const SIMILAR = {
  [C_UPDATE]: [
    { faqId: F_TRIAL, key: 'trial-cancel', questionEn: 'How do I cancel my trial?', questionZh: '怎么取消试用？', answerExcerptEn: 'Open Settings…', answerExcerptZh: '打开设置 > 订阅…', entry: true, score: 0.41, samePlace: false, placePath: path(['trial', '试用', 'Trial']), closeMatch: false },
    { faqId: F_REFUND, key: 'refund-how-long', questionEn: 'How long does a refund take?', questionZh: '退款需要多久？', answerExcerptEn: 'Refunds are processed within 3 working days.', answerExcerptZh: '退款会在 3 个工作日内处理。', entry: true, score: 0.91, samePlace: true, placePath: path(P_REFUND, P_REFUND_REQ), closeMatch: false },
    { faqId: F_REFUND_FAIL, key: 'refund-not-received', questionEn: 'I have not received my refund', questionZh: '退款一直没到账', answerExcerptEn: 'Banks can take 5–10 working days…', answerExcerptZh: '银行入账可能要 5 到 10 个工作日…', entry: true, score: 0.88, samePlace: true, placePath: path(P_REFUND, P_REFUND_LATE), closeMatch: true },
  ],
  [C_NEW]: [
    { faqId: F_DEVICE, key: 'device-limit', questionEn: 'How many devices can I use?', questionZh: '可以在几台设备上使用？', answerExcerptEn: 'Up to 3 devices.', answerExcerptZh: '最多 3 台设备。', entry: true, score: 0.52, samePlace: false, placePath: path(P_RULES, P_RULES_LIMIT), closeMatch: false },
  ],
  [C_RETIRE]: [
    { faqId: F_DEVICE_OLD, key: 'device-limit-2024', questionEn: 'What is the device limit?', questionZh: '设备上限是多少？', answerExcerptEn: 'Up to 2 devices.', answerExcerptZh: '最多 2 台设备。', entry: true, score: 0.95, samePlace: true, placePath: path(P_RULES, P_RULES_LIMIT), closeMatch: true },
    { faqId: F_DEVICE, key: 'device-limit', questionEn: 'How many devices can I use?', questionZh: '可以在几台设备上使用？', answerExcerptEn: 'Up to 3 devices.', answerExcerptZh: '最多 3 台设备。', entry: true, score: 0.93, samePlace: true, placePath: path(P_RULES, P_RULES_LIMIT), closeMatch: true },
  ],
}

const REVIEWS = {
  [C_UPDATE]: {
    recommendation: { action: 'update_faq', faqId: F_REFUND, rationale: '9 次提问像这张卡，其中 7 次当时给用户看的就是它，仍没解决', rationaleZh: '9 次提问像这张卡，其中 7 次当时给用户看的就是它，仍没解决', rationaleEn: '9 asks look like this card; 7 times it was shown and the user was still stuck', confidence: null },
    handling: [
      { exampleIndex: 0, shownFaqId: F_REFUND, outcome: 'not_helpful', reply: null },
      { exampleIndex: 1, shownFaqId: F_REFUND, outcome: 'ticket_after_chat', reply: null },
      { exampleIndex: 2, shownFaqId: null, outcome: 'handover', reply: null },
    ],
    places: [], regions: [{ key: 'refund', kind: 'stage', labelZh: '退款', labelEn: 'Refunds', score: 2.4 }],
    userStates: { total: 9, buckets: { paid_active: 4, cancelling: 3, ended: 2 } },
    netValue: { releaseVersion: 7, gains: 4, steals: 1, net: 3, evalCases: 23 },
  },
  [C_NEW]: {
    recommendation: { action: 'new_faq', faqId: null, rationale: '6 次提问都没找到卡', rationaleZh: '6 次提问都没找到卡', rationaleEn: '6 asks found no card', confidence: null },
    handling: [
      { exampleIndex: 0, shownFaqId: null, outcome: 'no_match', reply: null },
      { exampleIndex: 1, shownFaqId: null, outcome: 'no_match', reply: null },
    ],
    places: [
      { nodeId: N_ACCOUNT, kind: 'step', path: path(['account', '账号', 'Account'], ['account.signin', '登录', 'Sign in']), score: 1.6 },
      { nodeId: N_RULES_DEVICES, kind: 'cell', path: path(P_RULES, P_RULES_LIMIT), score: 1.1 },
    ],
    regions: [{ key: 'account', kind: 'stage', labelZh: '账号', labelEn: 'Account', score: 2.1 }],
    userStates: null,
    netValue: null,
  },
  [C_RETIRE]: {
    recommendation: { action: 'retire_faq', faqId: F_DEVICE_OLD, rationale: '和「可以在几台设备上使用？」在同一位置，几乎一样', rationaleZh: '和「可以在几台设备上使用？」在同一位置，几乎一样', rationaleEn: 'Same place as "How many devices can I use?" and nearly the same', confidence: null },
    handling: [{ exampleIndex: 0, shownFaqId: F_DEVICE_OLD, outcome: 'not_helpful', reply: null }],
    places: [], regions: [], userStates: { total: 2, buckets: { trial_active: 1, never_had_plan: 1 } }, netValue: null,
  },
}

const MAP = {
  version: 12,
  nodes: [
    { id: N_REFUND, key: 'refund', kind: 'stage', parentId: null, labelZh: '退款', labelEn: 'Refunds', position: 3, cards: 14 },
    { id: N_REFUND_REQ, key: 'refund.request', kind: 'step', parentId: N_REFUND, labelZh: '申请退款', labelEn: 'Request a refund', position: 1, cards: 6 },
    { id: N_REFUND_LATE, key: 'refund.late', kind: 'deviation', parentId: N_REFUND_REQ, labelZh: '退款没到账', labelEn: 'Refund not received', position: 1, cards: 3 },
    { id: N_ACCOUNT, key: 'account', kind: 'stage', parentId: null, labelZh: '账号', labelEn: 'Account', position: 1, cards: 20 },
    { id: id(208), key: 'account.signin', kind: 'step', parentId: N_ACCOUNT, labelZh: '登录', labelEn: 'Sign in', position: 1, cards: 9 },
    { id: N_DEVICE, key: 'account.device', kind: 'step', parentId: N_ACCOUNT, labelZh: '换设备', labelEn: 'Change device', position: 2, cards: 2 },
    { id: N_RULES, key: 'rules.devices', kind: 'object', parentId: null, labelZh: '设备规则', labelEn: 'Device rules', cards: 0 },
    { id: N_RULES_DEVICES, key: 'rules.devices.limit', kind: 'cell', parentId: N_RULES, attribute: 'limit', labelZh: '同时登录的设备数', labelEn: 'Devices signed in at once', cards: 4 },
  ],
}
// 「建议的位置」第一个故意指向阶段的 id：服务端只会给 step / deviation / cell，这里换成真正的步骤
REVIEWS[C_NEW].places[0].nodeId = id(208)

const FAQ_FULL = (faqId, questionZh, questionEn) => ({
  id: faqId, key: faqId, type: 'answer', entry: true, category: 'payments_subscriptions', popular: false, questionEn, questionZh,
  answerEn: 'Refunds are processed within 3 working days.', answerZh: '退款会在 3 个工作日内处理。', keywords: [], signals: [], status: 'published', version: 4,
  createdBy: 'e1', updatedBy: 'e1', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-28T08:00:00Z',
})

const ok = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message: code } }) })

function session(role) {
  return { employee: { employeeId: 'e1', loginEmail: 'jack@example.com', role, displayName: 'Jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
}

/** 一个页面一份假的服务端：记录写请求，决定之后候选换状态。 */
async function open(urlPath, { role = 'ADMIN', viewport = { width: 1440, height: 1000 }, review = true } = {}) {
  let rows = initialRows()
  const calls = []
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const decide = (cid, patch) => {
    rows = rows.map((row) => (row.id === cid ? { ...row, ...patch, version: row.version + 1, decidedAt: '2026-10-31T13:00:00Z' } : row))
    return rows.find((row) => row.id === cid)
  }
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const p = url.pathname
    const body = request.postData() ? JSON.parse(request.postData()) : null
    if (method !== 'GET') calls.push({ method, path: p, body })
    const m = p.match(/^\/api\/helpdesk\/faq-candidates\/([^/]+)(?:\/(\w+))?$/)
    if (p === '/api/session') return route.fulfill(ok(session(role)))
    if (p === '/api/helpdesk/faq-candidates') {
      const status = url.searchParams.get('status')
      const list = rows.filter((row) => !status || row.status === status)
      const counts = { new: 0, accepted: 0, dismissed: 0, merged: 0 }
      for (const row of rows) counts[row.status] += 1
      return route.fulfill(ok({ candidates: list, total: list.length, counts, page: 1, pageSize: 20, nodes: [] }))
    }
    if (m && method === 'GET' && !m[2]) {
      const row = rows.find((r) => r.id === m[1])
      return route.fulfill(row ? ok({ candidate: row, revisions: [], nodes: [] }) : fail(404, 'CANDIDATE_NOT_FOUND'))
    }
    if (m && m[2] === 'review') {
      if (!review) return route.fulfill(fail(404, 'NOT_FOUND'))
      const row = rows.find((r) => r.id === m[1])
      return route.fulfill(ok({ candidateId: m[1], version: row.version, similaritySource: 'vectors', similar: SIMILAR[m[1]], ...REVIEWS[m[1]] }))
    }
    if (m && m[2] === 'draft') {
      const row = rows.find((r) => r.id === m[1])
      return route.fulfill(ok({
        candidateId: m[1], version: row.version, suggestion: row.suggestion,
        faq: { type: 'answer', entry: true, category: 'account_technical', questionEn: 'I changed phone: how do I sign in?', questionZh: row.proposedQuestion, answerEn: '', answerZh: '', keywords: [] },
        parentId: null, relatedNodeId: null, phrasings: [], answerDraft: null,
      }))
    }
    if (m && m[2] === 'accept') return route.fulfill(ok({ candidate: decide(m[1], { status: 'accepted', acceptedAs: body.as }), replayed: false, phrasingsAdded: 1, phrasingsSkipped: 0, evalCasesAdded: 1, edgeId: null }))
    if (m && m[2] === 'dismiss') return route.fulfill(ok({ candidate: decide(m[1], { status: 'dismissed', reason: body.reason }), replayed: false }))
    if (m && m[2] === 'merge') return route.fulfill(ok({ source: decide(m[1], { status: 'merged', mergedInto: body.targetId }), target: null, replayed: false }))
    if (p === '/api/helpdesk/faq-map') return route.fulfill(ok(MAP))
    if (p === '/api/helpdesk/faqs' && method === 'POST') return route.fulfill(ok(FAQ_FULL(NEW_CARD, body.questionZh, body.questionEn), 201))
    if (p === `/api/helpdesk/faqs/${F_REFUND}` && method === 'GET') return route.fulfill(ok(FAQ_FULL(F_REFUND, '退款需要多久？', 'How long does a refund take?')))
    if (p === `/api/helpdesk/faqs/${F_REFUND}` && method === 'PUT') return route.fulfill(ok({ ...FAQ_FULL(F_REFUND, body.questionZh, body.questionEn), version: 5 }))
    if (/^\/api\/helpdesk\/faqs\/[^/]+\/(edges|phrasings)$/.test(p)) return route.fulfill(ok({ parents: [], children: [], phrasings: [] }))
    if (p === '/api/helpdesk/faqs') return route.fulfill(ok({ faqs: [], total: 0, page: 1, pageSize: 10 }))
    if (p === '/api/helpdesk/flywheel/jobs/gap_mining/runs') return route.fulfill(ok({ runs: [] }))
    if (p === '/api/helpdesk/jobs/assist-retention') return route.fulfill(ok({ job: 'assist_retention', retentionDays: 180, runs: [] }))
    if (p === '/api/helpdesk/tickets') return route.fulfill(ok({ tickets: [], nextCursor: null, counts: {} }))
    return route.fulfill(ok({}))
  })
  await page.goto(`${base}${urlPath}`)
  return { page, calls, errors }
}

/** 截图：内容在页面里的滚动区，临时把视口拉高到内容的高度再截。 */
const shot = async (page, name) => {
  if (!SHOTS) return
  const size = page.viewportSize()
  const height = await page.evaluate(() => {
    const scroller = document.querySelector('.hdFaqs')
    return scroller ? scroller.scrollHeight + 320 : document.documentElement.scrollHeight
  })
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  await page.setViewportSize(size)
}

test('switching to card review keeps the filters in the address bar and selects the first candidate', async () => {
  const { page, errors } = await open('/zh-CN/help-desk?tab=candidates')
  await page.locator('.hdCandidateTable tbody tr').first().waitFor()
  await page.getByRole('button', { name: '卡片审核' }).click()
  await page.locator('.hdReviewQueueCard').first().waitFor()
  assert.equal(new URL(page.url()).searchParams.get('view'), 'cards')
  assert.equal(await page.locator('.hdReviewQueueCard').count(), 3)
  assert.equal(await page.locator('.hdReviewQueueCard[aria-current="true"]').innerText().then((text) => text.includes('退款到账时间')), true)
  // AI 建议、用户原话、当时给看的卡
  const advice = page.locator('.hdReviewAdvice')
  await advice.getByText('更新已有卡 · 改卡片内容').waitFor()
  assert.ok(await advice.getByText('目标卡：退款需要多久？').isVisible())
  assert.equal(await page.getByText('当时给看的卡：退款需要多久？').count(), 2)
  assert.equal(await page.getByText('当时没给卡').count(), 1)
  // 相似卡：同位置在前（服务端顺序被打乱也一样）
  const questions = await page.locator('.hdReviewSimilarQuestion').allInnerTexts()
  assert.deepEqual(questions, ['退款需要多久？', '退款一直没到账', '怎么取消试用？'])
  assert.ok(await page.getByText('很接近：请读两张卡的答案').isVisible())
  // 提问用户的状态与净收益
  const states = page.locator('section', { has: page.getByRole('heading', { name: '提问用户的状态' }) })
  const legend = await states.locator('.hdReviewLegend li').allInnerTexts()
  assert.deepEqual(legend.map((line) => line.replace(/\s+/g, ' ').trim()), ['已付费 4 · 44%', '取消中 3 · 33%', '已结束 2 · 22%'])
  assert.equal(await states.locator('.hdReviewLegend li').count(), 3)
  assert.ok(await page.getByText('按第 7 版的评测，23 条用例。').isVisible())
  // 没有横向溢出
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`)
  await shot(page, 'review-update')
  assert.deepEqual(errors, [])
  await page.close()
})

test('update_faq: approve opens the target card in the FAQ editor and accepts it after save', async () => {
  const { page, calls } = await open('/zh-CN/help-desk?tab=candidates&view=cards')
  await page.locator('.hdReviewAdvice').waitFor()
  await page.getByRole('button', { name: '批准，去改这张卡' }).click()
  const drawer = page.getByRole('dialog', { name: '编辑常见问题' })
  await drawer.waitFor()
  await drawer.getByLabel('答案（中文）').fill('退款会在 3 个工作日内处理；银行入账另需 5 到 10 个工作日。')
  await drawer.getByRole('button', { name: '保存常见问题' }).click()
  await page.getByText('FAQ 已保存，候选已接受。').waitFor()
  const accept = calls.find((call) => call.path.endsWith('/accept'))
  assert.equal(accept.path, `/api/helpdesk/faq-candidates/${C_UPDATE}/accept`)
  assert.equal(accept.body.as, 'update_faq')
  assert.equal(accept.body.faqId, F_REFUND)
  assert.equal(accept.body.version, 2)
  assert.deepEqual(accept.body.phrasings, [0, 1])
  assert.equal(accept.body.placementNodeId, undefined)
  await page.close()
})

test('new_faq: a place is required; the suggested place goes into the accept call', async () => {
  const { page, calls } = await open(`/zh-CN/help-desk?tab=candidates&view=cards&review=${C_NEW}`)
  await page.locator('.hdReviewAdvice').getByText('新增 · 新建一张卡').waitFor()
  assert.equal(await page.getByText('暂无。Portal 还没提供用户状态。').count(), 1)
  assert.equal(await page.getByText('暂无。这张卡还没进过建版本的评测。').count(), 1)
  await page.getByRole('button', { name: '批准，去写新卡' }).click()
  await page.getByText('请选一个位置。').waitFor()
  assert.equal(calls.length, 0)
  await shot(page, 'review-new-place-required')
  await page.getByRole('radio', { name: /账号 › 登录/ }).check()
  await page.getByRole('button', { name: '批准，去写新卡' }).click()
  const drawer = page.getByRole('dialog', { name: '新增常见问题' })
  await drawer.waitFor()
  assert.equal(await drawer.getByLabel('问题（中文）').inputValue(), '换了新手机怎么登录原来的账号？')
  await drawer.getByLabel('答案（英文）').fill('Sign in with the same email on the new phone.')
  await drawer.getByLabel('答案（中文）').fill('在新手机上用原来的邮箱登录即可。')
  await drawer.getByRole('button', { name: '保存常见问题' }).click()
  await page.getByText('FAQ 已保存，候选已接受。').waitFor()
  const accept = calls.find((call) => call.path.endsWith('/accept'))
  assert.deepEqual(
    { as: accept.body.as, faqId: accept.body.faqId, placementNodeId: accept.body.placementNodeId, phrasings: accept.body.phrasings },
    { as: 'new_faq', faqId: NEW_CARD, placementNodeId: id(208), phrasings: [0, 1] },
  )
  await page.close()
})

test('the whole tree: suggested regions open by default, only steps / deviations / rule cells are selectable', async () => {
  const { page, calls } = await open(`/zh-CN/help-desk?tab=candidates&view=cards&review=${C_NEW}`)
  await page.locator('.hdReviewAdvice').waitFor()
  await page.getByRole('button', { name: '在整棵树里选' }).click()
  const tree = page.getByRole('list', { name: '流程树与规则表' })
  await tree.waitFor()
  const roots = tree.locator(':scope > li > details')
  const openState = await roots.evaluateAll((all) => all.map((d) => [d.querySelector('summary span').textContent, d.open]))
  assert.deepEqual(openState, [['账号', true], ['退款', false], ['设备规则', false]])
  // 阶段、对象没有单选
  assert.equal(await tree.getByRole('radio', { name: /^账号/ }).count(), 0)
  await tree.locator('summary', { hasText: '设备规则' }).click()
  await tree.getByRole('radio', { name: /同时登录的设备数/ }).check()
  await shot(page, 'review-tree')
  await page.getByRole('button', { name: '批准，去写新卡' }).click()
  await page.getByRole('dialog', { name: '新增常见问题' }).waitFor()
  assert.equal(calls.length, 0)
  await page.close()
})

test('retire_faq: two-step confirm, optional move of phrasings, then the queue moves on', async () => {
  const { page, calls } = await open(`/zh-CN/help-desk?tab=candidates&view=cards&review=${C_RETIRE}`)
  await page.locator('.hdReviewAdvice').waitFor()
  // 只有一个动作的类（标记失效、不改动）不重复写两遍
  assert.equal((await page.locator('.hdReviewAdviceTitle').innerText()).replace(/\s+/g, ' ').trim(), 'AI 建议 标记失效')
  // 把问法挪到另一张同位置的卡
  await page.locator('.hdReviewSimilar', { hasText: '可以在几台设备上使用？' }).getByRole('checkbox', { name: '问法挪到这张' }).check()
  await page.getByRole('button', { name: '批准下线' }).click()
  await page.getByText('确认把「设备上限是多少？」标记失效？它会归档，不会删除。').waitFor()
  assert.equal(calls.length, 0)
  await shot(page, 'review-retire-confirm')
  await page.getByRole('button', { name: '确认下线' }).click()
  await page.getByText('卡片已标记失效（编辑区）。').waitFor()
  assert.deepEqual(calls[0].body, { as: 'retire_faq', faqId: F_DEVICE_OLD, version: 2, moveTo: F_DEVICE })
  // 队列刷新（只看待处理的）：这一条走了，选中的换成前一条
  await page.waitForFunction(() => document.querySelectorAll('.hdReviewQueueCard').length === 2)
  assert.equal(new URL(page.url()).searchParams.get('review'), C_NEW)
  await page.close()
})

test('add_phrasing, no change, reject with a reason, and merge send the right calls', async () => {
  const { page, calls } = await open('/zh-CN/help-desk?tab=candidates&view=cards')
  await page.locator('.hdReviewAdvice').waitFor()
  // 只加问法：同一类里换动作，目标卡保留
  await page.getByRole('radio', { name: /只加问法/ }).check()
  await page.getByRole('button', { name: '批准，加问法' }).click()
  await page.getByText('问法已加进编辑区。').waitFor()
  assert.deepEqual(calls.at(-1).body, { as: 'add_phrasing', faqId: F_REFUND, phrasings: [0, 1], version: 2 })

  // 下一条（换设备登录）：不改动
  await page.locator('.hdReviewAdvice').getByText('新增 · 新建一张卡').waitFor()
  await page.getByRole('radio', { name: /^不改动/ }).check()
  await page.getByRole('button', { name: '确认不改动' }).click()
  await page.getByText('已记为不改动。').waitFor()
  assert.deepEqual(calls.at(-1).body, { reason: 'not_a_gap', version: 2 })
  await page.close()

  const second = await open(`/zh-CN/help-desk?tab=candidates&view=cards&review=${C_NEW}`)
  await second.page.locator('.hdReviewAdvice').waitFor()
  await second.page.getByRole('button', { name: '驳回' }).click()
  await second.page.getByRole('button', { name: '驳回候选' }).click()
  await second.page.getByText('请选择原因。').waitFor()
  await second.page.getByLabel(/^原因/).selectOption('out_of_scope')
  await second.page.getByRole('button', { name: '驳回候选' }).click()
  await second.page.getByText('已驳回候选。').waitFor()
  assert.deepEqual(second.calls.at(-1).body, { reason: 'out_of_scope', version: 2 })
  await second.page.close()

  const third = await open(`/zh-CN/help-desk?tab=candidates&view=cards&review=${C_RETIRE}`)
  await third.page.locator('.hdReviewAdvice').waitFor()
  await third.page.getByRole('button', { name: '合并' }).click()
  await third.page.getByLabel(/^合并到哪个候选/).selectOption(C_NEW)
  await third.page.getByRole('button', { name: '合并' }).click()
  await third.page.getByText('已合并候选。').waitFor()
  assert.deepEqual(third.calls.at(-1), { method: 'POST', path: `/api/helpdesk/faq-candidates/${C_RETIRE}/merge`, body: { targetId: C_NEW, version: 2 } })
  await third.page.close()
})

test('VIEW role sees everything but no decision controls; review data missing degrades to hints (en-GB)', async () => {
  const { page, errors } = await open('/en-GB/help-desk?tab=candidates&view=cards', { role: 'COURSE_CREATOR', review: false })
  await page.getByRole('heading', { name: 'Your decision' }).waitFor()
  assert.ok(await page.getByText('Your role can only view.').isVisible())
  assert.equal(await page.getByRole('button', { name: /Approve/ }).count(), 0)
  assert.equal(await page.getByRole('radio').count(), 0)
  assert.ok(await page.getByText(/Review data is not available yet/).isVisible())
  assert.ok(await page.getByText('Not available yet. Portal does not send user state yet.').isVisible())
  assert.deepEqual(errors, [])
  await page.close()
})

test('narrow screens: the side column moves under the main column without sideways scrolling', async () => {
  const { page } = await open('/zh-CN/help-desk?tab=candidates&view=cards', { viewport: { width: 1280, height: 900 } })
  await page.locator('.hdReviewAdvice').waitFor()
  const [main, side] = await Promise.all([page.locator('.hdReviewMain').boundingBox(), page.locator('.hdReviewSide').boundingBox()])
  assert.ok(side.y > main.y + main.height - 1, 'side column is below the main column')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`)
  await page.close()
})
