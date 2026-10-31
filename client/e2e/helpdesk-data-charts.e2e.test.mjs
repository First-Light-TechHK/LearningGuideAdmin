// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：「HelpDesk 数据」的折线图。
// 锁住（owner 2026-10-31：一个模块、可选着看、页面不拉长）：一排 7 个指标标签 + 一张大图，点哪个画哪个，跟着时间范围走；
// 没数据的桶断开不画成 0；悬停与键盘左右键出提示（日期、数值、分子 / 分母）；后台任务每天一格、失败标 ✕；
// 趋势表默认收起；缺口组与导致工单的 FAQ 在一个模块里切换、各先看 5 条；en-GB 文案；指标读不到时不崩。
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

const DAY = 86_400_000
const days = (from, to) => {
  const out = []
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY) out.push(new Date(at).toISOString().slice(0, 10))
  return out
}

function row(bucket, index) {
  const turns = 40 + ((index * 7) % 23)
  const answersSettled = turns - 6
  const aiSolved = Math.round(answersSettled * (0.5 + (index % 5) * 0.05))
  // 第 3 个桶没有任何投票：有帮助率是 null（线断开）
  const votes = index === 2 ? 0 : 10
  const helpful = index === 2 ? 0 : 6 + (index % 4)
  const ratings = index === 2 ? 0 : 5
  const ratingSum = index === 2 ? 0 : 19 + (index % 3)
  const handovers = 2 + (index % 3)
  const noMatch = 3 + (index % 4)
  return {
    bucket, segment: 'all', turns, answers: answersSettled, answersSettled, aiSolved, noMatch, votes, helpful, ratings, ratingSum, handovers,
    clarify: 0, clarifyCovered: 0, guarded: 0, guardFallback: 0, unsolved: 0,
    aiSolvedRate: aiSolved / answersSettled, noMatchRate: noMatch / turns, helpfulRate: votes ? helpful / votes : null,
    avgRating: ratings ? ratingSum / ratings : null, handoverRate: handovers / turns, clarifyCoveredRate: null, guardFallbackRate: null,
  }
}

function totalsOf(rows) {
  const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0)
  const t = Object.fromEntries(['turns', 'answers', 'answersSettled', 'aiSolved', 'noMatch', 'votes', 'helpful', 'ratings', 'ratingSum', 'handovers', 'clarify', 'clarifyCovered', 'guarded', 'guardFallback', 'unsolved'].map((k) => [k, sum(k)]))
  return {
    ...t, bucket: null, segment: 'all',
    aiSolvedRate: t.aiSolved / t.answersSettled, noMatchRate: t.noMatch / t.turns, helpfulRate: t.helpful / t.votes, avgRating: t.ratingSum / t.ratings,
    handoverRate: t.handovers / t.turns, clarifyCoveredRate: null, guardFallbackRate: null,
  }
}

function runs() {
  const today = new Date().toISOString().slice(0, 10)
  return days(new Date(Date.now() - 9 * DAY).toISOString().slice(0, 10), today).map((day, index) => ({
    id: `run-${day}`, job: 'gap_mining', day, trigger: 'schedule', status: index === 4 ? 'failed' : 'succeeded', attempts: 1, instance: 'i1',
    startedAt: `${day}T02:00:00Z`, heartbeatAt: `${day}T02:00:10Z`, finishedAt: `${day}T02:01:00Z`, durationMs: 60000,
    stats: index === 4 ? {} : { pull: { status: 'pulled', received: 100 + index * 10 }, mine: { created: index % 3 } },
    moreDue: false, errorCode: index === 4 ? 'PORTAL_UNAVAILABLE' : null, requestedBy: null,
  }))
}

const GAPS = Array.from({ length: 8 }, (_, i) => ({ candidateId: `c${i}`, topic: `话题 ${i + 1}`, proposedQuestion: `问题 ${i + 1}？`, suggestion: 'new_faq', status: 'new', turns: 20 - i }))
const TICKET_FAQS = Array.from({ length: 3 }, (_, i) => ({ faqId: `f${i}`, answers: 30 - i, ticketsAfter: 5 - i, ticketRate: (5 - i) / (30 - i), key: `k${i}`, questionEn: `Q${i}`, questionZh: `卡 ${i}` }))

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message: code } }) })

function session() {
  return { employee: { employeeId: 'e1', loginEmail: 'jack@example.com', role: 'ADMIN', displayName: 'Jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
}

async function open(urlPath, { viewport = { width: 1440, height: 1000 }, metricsDown = false } = {}) {
  const page = await browser.newPage({ viewport })
  const errors = []
  const asked = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === '/api/session') return route.fulfill(ok(session()))
    if (p === '/api/helpdesk/flywheel/metrics') {
      if (metricsDown) return route.fulfill(fail(503, 'PORTAL_UNAVAILABLE'))
      const q = Object.fromEntries(url.searchParams)
      asked.push(q)
      const series = days(q.from, q.to).map(row)
      return route.fulfill(ok({
        granularity: q.granularity, split: q.split, from: q.from, to: q.to, lastIngestedAt: '2026-10-31T02:00:00Z', source: 'portal_insights',
        timezone: 'UTC', weekStartsOn: 'monday', series, totals: [totalsOf(series)], topGaps: GAPS, ticketFaqs: TICKET_FAQS,
      }))
    }
    if (p === '/api/helpdesk/flywheel/jobs/gap_mining/runs') return route.fulfill(ok({ runs: runs() }))
    if (p === '/api/helpdesk/tickets') return route.fulfill(ok({ tickets: [], nextCursor: null, counts: {} }))
    return route.fulfill(ok({}))
  })
  await page.goto(`${base}${urlPath}`)
  return { page, errors, asked }
}

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('one trend module: metric tabs on top, one big chart below that follows the tab and the time range; page stays short', async () => {
  const { page, errors, asked } = await open('/zh-CN/help-desk?tab=data', { viewport: { width: 1440, height: 900 } })
  const tabs = page.locator('.hdTrendTabs [role="tab"]')
  await tabs.first().waitFor()
  await page.locator('path.hdChartLine').waitFor()
  assert.deepEqual(await page.locator('.hdTrendName').allInnerTexts(), ['提问量', 'AI 解决率', '没有匹配率', '转人工率', '有帮助率', '平均评分', '后台任务'])
  // 只有一张图；默认是 AI 解决率
  assert.equal(await page.locator('.hdChartPlot').count(), 1)
  assert.equal(await page.getByRole('tab', { name: 'AI 解决率' }).getAttribute('aria-selected'), 'true')
  assert.equal((await page.locator('.hdChartRule text').allTextContents())[0], '0%')
  // 标签里有整段时间的值和比前一天的变化（带箭头，不只靠颜色）
  const solved = page.getByRole('tab', { name: 'AI 解决率' })
  assert.match(await solved.locator('.hdTrendValue').innerText(), /%$/)
  assert.match(await solved.locator('.hdTrendChange').innerText(), /[▲▼•][\s\S]*个百分点/)
  assert.match(await page.locator('.hdTrendCaption').innerText(), /箭头是和前一天比/)
  // 换到有帮助率：第 3 天没票，线断成两段（两个 M），不是画到 0
  await page.getByRole('tab', { name: '有帮助率' }).click()
  assert.match(await page.locator('.hdTrendCaption').innerText(), /有帮助/)
  assert.equal((await page.locator('path.hdChartLine').getAttribute('d')).match(/M/g).length, 2)
  // 评分：轴固定 1 到 5
  await page.getByRole('tab', { name: '平均评分' }).click()
  assert.deepEqual(await page.locator('.hdChartRule text').allTextContents(), ['1', '3', '5'])
  // 键盘：左右键在标签之间移动
  await page.getByRole('tab', { name: '平均评分' }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.getByRole('tab', { name: '后台任务' }).getAttribute('aria-selected'), 'true')
  // 页面不拉长：趋势表默认收起，缺口和工单在同一个模块里切换，各先看 5 条
  assert.equal(await page.getByRole('table', { name: '趋势' }).isVisible(), false)
  await page.getByText('查看趋势表格').click()
  assert.equal(await page.getByRole('table', { name: '趋势' }).locator('tbody tr').count(), 28)
  await page.getByText('查看趋势表格').click()
  const gaps = page.getByRole('table', { name: '最大的缺口组' })
  assert.equal(await gaps.locator('tbody tr').count(), 5)
  await page.getByRole('button', { name: '显示全部 8 条' }).click()
  assert.equal(await gaps.locator('tbody tr').count(), 8)
  await page.getByRole('tab', { name: /最常导致工单的 FAQ/ }).click()
  await page.getByRole('table', { name: '最常导致工单的 FAQ' }).waitFor()
  assert.equal(await page.getByRole('table', { name: '最大的缺口组' }).count(), 0)
  // 按周：重新取数
  await page.getByLabel('周期').selectOption('week')
  await page.waitForFunction(() => document.querySelectorAll('.hdTrendTabs [role="tab"]').length === 7)
  await page.waitForTimeout(200)
  assert.equal(asked.at(-1).granularity, 'week')
  const scroller = await page.evaluate(() => {
    const el = document.querySelector('.hdFaqs')
    return { content: el.scrollHeight, view: el.clientHeight }
  })
  assert.ok(scroller.content < scroller.view * 1.6, `data page is long: ${scroller.content} vs ${scroller.view}`)
  assert.deepEqual(errors, [])
  await page.close()
})

test('hover and arrow keys show the bucket, value and parts; background job tab shows the run strip', async () => {
  const { page, errors } = await open('/zh-CN/help-desk?tab=data', { viewport: { width: 1440, height: 900 } })
  await page.locator('path.hdChartLine').waitFor()
  await page.waitForTimeout(800)
  await shot(page, 'data-trend')
  const plot = page.locator('.hdChartPlot')
  const box = await plot.boundingBox()
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2)
  const tip = page.locator('.hdChartTip')
  await tip.waitFor()
  assert.match(await tip.innerText(), /AI 解决率/)
  assert.match(await tip.innerText(), /\d+%/)
  assert.match(await tip.innerText(), /中的/)
  await shot(page, 'data-trend-hover')
  await page.mouse.move(0, 0)
  await tip.waitFor({ state: 'detached' })
  await plot.focus()
  await page.keyboard.press('ArrowRight')
  await tip.waitFor()
  const first = await tip.innerText()
  await page.keyboard.press('ArrowRight')
  assert.notEqual(await tip.innerText(), first)
  await page.keyboard.press('Escape')
  await tip.waitFor({ state: 'detached' })
  // 后台任务：10 天，1 天失败；失败那天线断开
  await page.getByRole('tab', { name: '后台任务' }).click()
  assert.equal(await page.locator('.hdTrendTabOn .hdTrendValue').innerText(), '9/10')
  assert.equal(await page.locator('.hdRunMark').count(), 10)
  assert.equal(await page.locator('.hdRunMark-failed').innerText(), '✕')
  assert.match(await page.locator('.hdRunMark-failed').getAttribute('aria-label'), /失败 · PORTAL_UNAVAILABLE/)
  assert.match(await page.locator('.hdRunStripLabel').innerText(), /最近 10 天里有 1 天失败/)
  assert.equal((await page.locator('path.hdChartLine').getAttribute('d')).match(/M/g).length, 2)
  await page.waitForTimeout(800)
  await shot(page, 'data-trend-job')
  assert.deepEqual(errors, [])
  await page.close()
})

test('en-GB at 1280: labels, seven tabs in one row without overflow; the page survives when metrics cannot be read', async () => {
  const { page, errors } = await open('/en-GB/help-desk?tab=data', { metricsDown: true })
  await page.locator('.hdFaqError').waitFor()
  assert.equal(await page.locator('.hdTrend').count(), 0)
  await page.close()
  const second = await open('/en-GB/help-desk?tab=data', { viewport: { width: 1280, height: 800 } })
  await second.page.locator('path.hdChartLine').waitFor()
  assert.equal(await second.page.locator('.hdTrendName').first().innerText(), 'Questions')
  assert.match(await second.page.locator('.hdTrendChange').nth(1).innerText(), /pts/)
  assert.match(await second.page.locator('.hdTrendCaption').innerText(), /compare with the day before/)
  // 1280 宽：7 个标签仍是一行
  const tops = await second.page
    .locator('.hdTrendTabs [role="tab"]')
    .evaluateAll((tabs) => new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size)
  assert.equal(tops, 1)
  const overflow = await second.page.evaluate(() => {
    const module = document.querySelector('.hdTrend')
    return module.scrollWidth > module.clientWidth + 1
  })
  assert.equal(overflow, false)
  await second.page.waitForTimeout(800)
  await shot(second.page, 'data-trend-1280-en')
  assert.deepEqual([...errors, ...second.errors], [])
  await second.page.close()
})
