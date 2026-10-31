// 浏览器 E2E（真 Chromium + Vite dev server，API 全部在浏览器里假装）：FAQ 候选「卡片审核」视图（第二版，一屏）。
// 锁住：切到卡片审核（地址栏 view=cards、review=<id>）；1440×900 和 1280×800 一屏放得下、页面不滚动、主按钮看得见；
// AI 建议一句话说清，和 AI 一样时不重复；运营在审核页里直接改卡片内容（改卡要真改过、新卡先存再批准且带 placementNodeId）；
// 新卡必须选位置（建议的胶囊或整棵树的浮层，可搜索）；下线要二次确认并可挪说法；只加说法 / 不用改 / 驳回 / 合并；
// 批准后跳到队列下一条；J / K 切换、Ctrl+Enter 提交；VIEW 角色只读（en-GB）；审核数据读不到时仍能看候选。
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
    const faq = p.match(/^\/api\/helpdesk\/faqs\/([^/]+)$/)
    if (faq && method === 'GET') {
      const card = Object.values(SIMILAR).flat().find((s) => s.faqId === faq[1])
      return route.fulfill(card ? ok(FAQ_FULL(card.faqId, card.questionZh, card.questionEn)) : fail(404, 'FAQ_NOT_FOUND'))
    }
    if (faq && method === 'PUT') return route.fulfill(ok({ ...FAQ_FULL(faq[1], body.questionZh, body.questionEn), answerZh: body.answerZh, version: 5 }))
    if (p === '/api/helpdesk/faqs/rewrite' && method === 'POST') {
      if (body.instruction.includes('失败')) return route.fulfill(fail(503, 'MODEL_UNAVAILABLE'))
      if (body.instruction.includes('不用改')) return route.fulfill(ok({ draft: { ...body, instruction: undefined }, changed: [], model: 'deepseek', costUsd: 0 }))
      const draft = { questionZh: body.questionZh, answerZh: body.answerZh, questionEn: body.questionEn, answerEn: body.answerEn, category: body.category }
      if (body.selection) {
        const text = draft[body.selection.field]
        draft[body.selection.field] = `${text.slice(0, body.selection.start)}【改】${text.slice(body.selection.end)}`
      } else if (body.lang === 'zh') draft.answerZh = `（AI 改写）${body.answerZh}`
      else draft.answerEn = `(AI) ${body.answerEn}`
      return route.fulfill(ok({ draft, changed: ['answerZh'], model: 'deepseek', costUsd: 0.0001 }))
    }
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
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const CARDS = '/zh-CN/help-desk?tab=candidates&view=cards'
const sent = (calls, re) => calls.filter((call) => re.test(call.path))
const primary = (page) => page.locator('.hdReviewPrimary')
const waitPanel = async (page, topic) => {
  await page.locator('.hdReviewTopic', { hasText: topic }).waitFor()
  await page.locator('.hdReviewPanel[aria-busy="false"]').waitFor()
}

/** 一屏：页面本身不滚动，主按钮在视口里，三栏不横向溢出。 */
async function assertOneScreen(page) {
  const box = await page.evaluate(() => {
    const doc = document.scrollingElement
    const button = document.querySelector('.hdReviewPrimary')?.getBoundingClientRect()
    const layout = document.querySelector('.hdReviewLayout')
    return {
      pageScroll: doc.scrollHeight - window.innerHeight,
      pageScrollX: doc.scrollWidth - window.innerWidth,
      layoutOverflowX: layout.scrollWidth - layout.clientWidth,
      buttonBottom: button ? button.bottom : null,
      viewport: window.innerHeight,
    }
  })
  assert.ok(box.pageScroll <= 1, `page scrolls by ${box.pageScroll}px`)
  assert.ok(box.pageScrollX <= 1, `page scrolls sideways by ${box.pageScrollX}px`)
  assert.ok(box.layoutOverflowX <= 1, `layout overflows by ${box.layoutOverflowX}px`)
  assert.ok(box.buttonBottom !== null && box.buttonBottom <= box.viewport, 'primary button is on screen')
}

test('switching to card review: address bar, first candidate, one screen at 1440×900, AI sentence said once', async () => {
  const { page, errors } = await open('/zh-CN/help-desk?tab=candidates', { viewport: { width: 1440, height: 900 } })
  await page.locator('.hdCandidateTable tbody tr').first().waitFor()
  await page.getByRole('button', { name: '卡片审核' }).click()
  await waitPanel(page, '退款到账时间')
  assert.equal(new URL(page.url()).searchParams.get('view'), 'cards')
  assert.equal(await page.locator('.hdReviewQueueCard').count(), 3)
  assert.match(await page.locator('.hdReviewQueueCard[aria-current="true"]').innerText(), /退款到账时间/)
  assert.match(await page.locator('.hdReviewQueueHead').innerText(), /待审核 3 条/)
  // 一句话的 AI 建议 + 理由；下拉框里 AI 建议的选项带标记，和 AI 一样时不再重复一句
  await page.locator('.hdReviewAdviceText', { hasText: '改一下「退款需要多久？」的内容' }).waitFor()
  assert.ok(await page.getByText('9 次提问像这张卡').first().isVisible())
  const how = page.getByLabel('处理方式')
  assert.equal(await how.inputValue(), 'update_faq')
  assert.match(await how.locator('option[value="update_faq"]').innerText(), /AI 建议/)
  assert.equal(await page.locator('.hdReviewWill').count(), 0)
  // 改卡：卡片内容直接摆在右栏可以改
  assert.equal(await page.getByLabel('答案（中文）').inputValue(), '退款会在 3 个工作日内处理。')
  // 提问用户的状态与预计效果
  assert.match(await page.locator('.hdReviewFacts').innerText(), /9/)
  assert.match(await page.locator('.hdReviewFacts').innerText(), /\+?3/)
  await assertOneScreen(page)
  await shot(page, 'review-update')
  assert.deepEqual(errors, [])
  await page.close()
})

test('update_faq: must actually change the card; saves the card (PUT) then accepts, then moves to the next candidate', async () => {
  const { page, calls, errors } = await open(CARDS)
  await waitPanel(page, '退款到账时间')
  await primary(page).click()
  await page.getByText('内容还没改').waitFor()
  assert.equal(calls.length, 0)
  const answer = page.getByLabel('答案（中文）')
  await answer.fill('退款会在 3 个工作日内处理，银行入账还要 5 到 10 个工作日。')
  assert.match(await primary(page).innerText(), /保存修改并批准/)
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '卡片修改已存进编辑区' }).waitFor()
  const put = sent(calls, new RegExp(`/api/helpdesk/faqs/${F_REFUND}$`))
  assert.equal(put.length, 1)
  assert.equal(put[0].method, 'PUT')
  assert.equal(put[0].body.version, 4)
  assert.match(put[0].body.answerZh, /5 到 10 个工作日/)
  const accept = sent(calls, /\/accept$/)
  assert.equal(accept.length, 1)
  assert.equal(accept[0].body.as, 'update_faq')
  assert.equal(accept[0].body.faqId, F_REFUND)
  // 含隐藏个人信息的第 3 条说法不会被带上
  assert.deepEqual(accept[0].body.phrasings, [0, 1])
  assert.ok(calls.indexOf(put[0]) < calls.indexOf(accept[0]), 'card saved before the candidate is accepted')
  // 跳到下一条
  await waitPanel(page, '换设备登录')
  assert.equal(new URL(page.url()).searchParams.get('review'), C_NEW)
  assert.equal(await page.locator('.hdReviewQueueCard').count(), 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('new_faq: place is required; the tree overlay searches and picks; the card is created first, then accepted with the place', async () => {
  const { page, calls, errors } = await open(`${CARDS}&review=${C_NEW}`)
  await waitPanel(page, '换设备登录')
  assert.equal(await page.getByLabel('问题（中文）').inputValue(), '换了新手机怎么登录原来的账号？')
  // 建议的位置是胶囊，不预选
  const chips = page.locator('.hdReviewChips .hdReviewChip input[type="radio"]')
  assert.equal(await chips.count(), 2)
  assert.equal(await page.locator('.hdReviewChips input:checked').count(), 0)
  await primary(page).click()
  await page.getByText('请选放在哪。').waitFor()
  assert.equal(calls.length, 0)
  // 整棵树：浮层 + 搜索，只有步骤 / 偏离 / 规则格能选
  await page.getByRole('button', { name: '其他位置…' }).click()
  const tree = page.getByRole('dialog', { name: '选位置' })
  await tree.waitFor()
  await shot(page, 'review-tree')
  await tree.getByRole('searchbox').fill('换设备')
  assert.equal(await tree.locator('input[type="radio"]').count(), 1)
  await tree.locator('label', { hasText: '换设备' }).click()
  await tree.waitFor({ state: 'detached' })
  assert.match(await page.locator('.hdReviewChips').innerText(), /账号 › 换设备/)
  // 中文答案、英文答案都要填：先只填中文，提交后跳到有错的英文
  await page.getByLabel('答案（中文）').fill('在新手机上用原来的邮箱登录，收验证码即可。')
  await primary(page).click()
  await page.getByLabel('答案（英文）').waitFor()
  assert.equal(calls.length, 0)
  await page.getByLabel('答案（英文）').fill('Sign in on the new phone with the same email and enter the code we send.')
  // Ctrl+Enter 提交
  await page.getByLabel('答案（英文）').press('Control+Enter')
  await page.locator('.hdReviewToast', { hasText: '新卡已存进编辑区' }).waitFor()
  const post = calls.filter((call) => call.method === 'POST' && call.path === '/api/helpdesk/faqs')
  assert.equal(post.length, 1)
  assert.equal(post[0].body.entry, true)
  assert.equal(post[0].body.answerZh, '在新手机上用原来的邮箱登录，收验证码即可。')
  const accept = sent(calls, /\/accept$/)
  assert.equal(accept.length, 1)
  assert.deepEqual(
    { as: accept[0].body.as, faqId: accept[0].body.faqId, placementNodeId: accept[0].body.placementNodeId },
    { as: 'new_faq', faqId: NEW_CARD, placementNodeId: N_DEVICE },
  )
  assert.deepEqual(errors, [])
  await page.close()
})

test('retire_faq: two-step confirm, phrasings can move to another card from the similar list', async () => {
  const { page, calls, errors } = await open(`${CARDS}&review=${C_RETIRE}`)
  await waitPanel(page, '旧版设备上限')
  assert.equal(await page.getByLabel('处理方式').inputValue(), 'retire_faq')
  await page.getByRole('tab', { name: /相似的卡/ }).click()
  const rows = page.locator('.hdReviewScroll[role="tabpanel"] .hdReviewRow')
  assert.equal(await rows.count(), 2)
  assert.match(await rows.nth(0).innerText(), /很接近/)
  await rows.filter({ hasText: '可以在几台设备上使用？' }).getByRole('button', { name: '说法挪到这张' }).click()
  assert.match(await page.locator('.hdReviewDecide').innerText(), /可以在几台设备上使用？/)
  await primary(page).click()
  await page.locator('.hdReviewFootAlert', { hasText: '确认把「设备上限是多少？」下线？' }).waitFor()
  assert.equal(calls.length, 0)
  assert.match(await primary(page).innerText(), /确认下线/)
  await shot(page, 'review-retire')
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '卡片已下线' }).waitFor()
  const accept = sent(calls, /\/accept$/)
  assert.equal(accept.length, 1)
  assert.deepEqual(
    { as: accept[0].body.as, faqId: accept[0].body.faqId, moveTo: accept[0].body.moveTo },
    { as: 'retire_faq', faqId: F_DEVICE_OLD, moveTo: F_DEVICE },
  )
  assert.deepEqual(errors, [])
  await page.close()
})

test('other actions: add phrasings only, reject with a reason, no change; the sentence shows when it differs from the AI', async () => {
  const { page, calls, errors } = await open(CARDS)
  await waitPanel(page, '退款到账时间')
  await page.getByLabel('处理方式').selectOption('add_phrasing')
  await page.locator('.hdReviewWill', { hasText: '把用户的 2 种说法加到「退款需要多久？」' }).waitFor()
  // 只加说法：卡片内容只读预览，可以一键切回直接改
  assert.equal(await page.getByLabel('答案（中文）').count(), 0)
  assert.ok(await page.getByRole('button', { name: '直接改这张卡的内容' }).isVisible())
  // 去掉一条说法
  await page.locator('.hdReviewCheck input').first().uncheck()
  assert.match(await primary(page).innerText(), /加 1 种说法/)
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '说法已加进编辑区' }).waitFor()
  let accept = sent(calls, /\/accept$/)
  assert.deepEqual({ as: accept[0].body.as, faqId: accept[0].body.faqId, phrasings: accept[0].body.phrasings }, { as: 'add_phrasing', faqId: F_REFUND, phrasings: [1] })
  assert.equal(sent(calls, /\/api\/helpdesk\/faqs/).length, 0, 'adding phrasings does not touch the card itself')

  // 驳回：必须选原因
  await waitPanel(page, '换设备登录')
  await page.getByRole('button', { name: '驳回', exact: true }).click()
  await page.getByRole('button', { name: /驳回候选/ }).click()
  await page.locator('.hdFieldError').first().waitFor()
  assert.equal(sent(calls, /\/dismiss$/).length, 0)
  await page.getByLabel('原因').selectOption('duplicate')
  await page.getByRole('button', { name: /驳回候选/ }).click()
  await page.locator('.hdReviewToast', { hasText: '已驳回候选' }).waitFor()
  assert.equal(sent(calls, /\/dismiss$/)[0].body.reason, 'duplicate')

  // 不用改
  await waitPanel(page, '旧版设备上限')
  await page.getByLabel('处理方式').selectOption('no_change')
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '已记为不用改' }).waitFor()
  const dismiss = sent(calls, /\/dismiss$/)
  assert.equal(dismiss.length, 2)
  assert.equal(dismiss[1].body.reason, 'not_a_gap')
  assert.equal(dismiss[1].path, `/api/helpdesk/faq-candidates/${C_RETIRE}/dismiss`)
  assert.deepEqual(errors, [])
  await page.close()
})

test('merge into another pending candidate', async () => {
  const { page, calls, errors } = await open(`${CARDS}&review=${C_NEW}`)
  await waitPanel(page, '换设备登录')
  await page.getByRole('button', { name: '合并', exact: true }).click()
  await page.getByRole('button', { name: /^合并/ }).last().click()
  await page.getByText('请选一个候选。').waitFor()
  await page.getByLabel('合并到哪个候选').selectOption(C_UPDATE)
  await page.getByRole('button', { name: /^合并/ }).last().click()
  await page.locator('.hdReviewToast', { hasText: '已合并候选' }).waitFor()
  const merge = sent(calls, /\/merge$/)
  assert.equal(merge.length, 1)
  assert.equal(merge[0].body.targetId, C_UPDATE)
  assert.deepEqual(errors, [])
  await page.close()
})

test('J / K move through the queue, but not while typing', async () => {
  const { page, errors } = await open(CARDS)
  await waitPanel(page, '退款到账时间')
  await page.locator('.hdReviewTopic').click()
  await page.keyboard.press('j')
  await waitPanel(page, '换设备登录')
  assert.equal(new URL(page.url()).searchParams.get('review'), C_NEW)
  await page.getByLabel('答案（中文）').focus()
  await page.keyboard.press('j')
  assert.equal(new URL(page.url()).searchParams.get('review'), C_NEW)
  assert.match(await page.getByLabel('答案（中文）').inputValue(), /j$/)
  await page.locator('.hdReviewTopic').click()
  await page.keyboard.press('k')
  await waitPanel(page, '退款到账时间')
  assert.deepEqual(errors, [])
  await page.close()
})

test('a view-only role (COURSE_CREATOR) in en-GB is read-only, and the candidate still shows when review data is missing', async () => {
  const { page, errors } = await open('/en-GB/help-desk?tab=candidates&view=cards', { role: 'COURSE_CREATOR', review: false })
  await page.locator('.hdReviewTopic', { hasText: '退款到账时间' }).waitFor()
  await page.getByText('Your role can only view.').waitFor()
  assert.equal(await primary(page).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Reject', exact: true }).count(), 0)
  await page.getByRole('tab', { name: /Similar cards/ }).click()
  await page.locator('.hdGraphHint', { hasText: /Review data|review data/ }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

test('1280×800: still one screen, the language switch stays on one line', async () => {
  const { page, errors } = await open(`${CARDS}&review=${C_NEW}`, { viewport: { width: 1280, height: 800 } })
  await waitPanel(page, '换设备登录')
  await assertOneScreen(page)
  // 不换行，且每一段都在分段按钮里放得下
  const fits = await page.locator('.hdReviewSegItem').evaluateAll((items) => items.map((item) => item.scrollWidth <= item.clientWidth))
  assert.deepEqual(fits, [true, true])
  const wraps = await page.locator('.hdReviewSegItem').evaluateAll((items) => items.map((item) => getComputedStyle(item).whiteSpace))
  assert.deepEqual(wraps, ['nowrap', 'nowrap'], 'segment items must not wrap')
  await shot(page, 'review-1280')
  assert.deepEqual(errors, [])
  await page.close()
})

test('artifact-style editing: tell AI how to change the card, versions switch back and forth, the saved card is the current version', async () => {
  const { page, calls, errors } = await open(CARDS, { viewport: { width: 1440, height: 900 } })
  await waitPanel(page, '退款到账时间')
  const answer = page.getByLabel('答案（中文）')
  const original = await answer.inputValue()
  assert.match(await page.locator('.hdVersionCount').innerText(), /版本 1 \/ 1/)
  assert.match(await page.locator('.hdVersionNote').innerText(), /现在的卡/)
  // 跟 AI 说怎么改（Enter 发送）
  const ask = page.getByLabel('告诉 AI 怎么改这张卡')
  await ask.fill('答案短一点')
  await ask.press('Enter')
  await page.locator('.hdVersionCount', { hasText: '版本 2 / 2' }).waitFor()
  assert.match(await page.locator('.hdVersionNote').innerText(), /AI 按「答案短一点」改/)
  assert.equal(await answer.inputValue(), `（AI 改写）${original}`)
  assert.match(await answer.getAttribute('class'), /hdReviewTextChanged/)
  assert.equal(await ask.inputValue(), '')
  const rewrite = calls.filter((call) => call.path === '/api/helpdesk/faqs/rewrite')
  assert.equal(rewrite.length, 1)
  assert.deepEqual([rewrite[0].body.instruction, rewrite[0].body.lang, rewrite[0].body.selection], ['答案短一点', 'zh', undefined])
  await shot(page, 'review-assist')
  // 切回版本 1，再切回来
  await page.getByRole('button', { name: '上一个版本' }).click()
  assert.equal(await answer.inputValue(), original)
  await page.getByRole('button', { name: '下一个版本' }).click()
  assert.equal(await answer.inputValue(), `（AI 改写）${original}`)
  // 选中一段只改那一段
  await answer.evaluate((node) => {
    node.focus()
    node.setSelectionRange(6, 6)
  })
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await page.locator('.hdComposerScope').waitFor()
  await page.getByRole('button', { name: '短一点' }).click()
  await page.locator('.hdVersionCount', { hasText: '版本 3 / 3' }).waitFor()
  const scoped = calls.filter((call) => call.path === '/api/helpdesk/faqs/rewrite')[1].body
  assert.deepEqual(scoped.selection, { field: 'answerZh', start: 6, end: 10 })
  assert.match(await answer.inputValue(), /【改】/)
  // AI 失败：原文不动、提示；AI 没改：不加版本
  await ask.fill('这次会失败')
  await ask.press('Enter')
  await page.locator('.hdComposerWrap [role="alert"]').waitFor()
  assert.match(await page.locator('.hdVersionCount').innerText(), /版本 3 \/ 3/)
  await ask.fill('不用改')
  await ask.press('Enter')
  await page.getByText('AI 没有改动').waitFor()
  assert.match(await page.locator('.hdVersionCount').innerText(), /版本 3 \/ 3/)
  // 人手改：新版本「你改的」，连续输入只算一个
  await answer.fill(`${await answer.inputValue()}。`)
  await answer.press('End')
  await answer.type('好')
  assert.match(await page.locator('.hdVersionCount').innerText(), /版本 4 \/ 4/)
  assert.match(await page.locator('.hdVersionNote').innerText(), /你改的/)
  const final = await answer.inputValue()
  await primary(page).click()
  await page.locator('.hdReviewToast', { hasText: '卡片修改已存进编辑区' }).waitFor()
  const put = calls.find((call) => call.method === 'PUT')
  assert.equal(put.body.answerZh, final)
  assert.deepEqual(errors, [])
  await page.close()
})
