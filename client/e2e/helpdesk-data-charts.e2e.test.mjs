// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：「HelpDesk 数据」的折线图。
// 锁住：7 张图（提问量、AI 解决率、没匹配率、转人工率、有帮助率、平均评分、后台任务）跟着时间范围走；
// 没数据的桶断开不画成 0；悬停与键盘左右键出提示（日期、数值、分子 / 分母）；后台任务每天一格、失败标 ✕；
// 图下面的趋势表还在（表格视图）；en-GB 文案；指标读不到时不崩。
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
        timezone: 'UTC', weekStartsOn: 'monday', series, totals: [totalsOf(series)], topGaps: [], ticketFaqs: [],
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

test('seven line charts follow the time range; gaps are not drawn as zero; the trend table stays', async () => {
  const { page, errors, asked } = await open('/zh-CN/help-desk?tab=data')
  const charts = page.locator('figure.hdChart')
  await charts.first().waitFor()
  await page.locator('.hdRunMark').first().waitFor()
  assert.equal(await charts.count(), 7)
  const titles = await page.locator('.hdChartTitle').allInnerTexts()
  assert.deepEqual(titles, ['提问量（轮）', 'AI 解决率', '没有匹配率', '转人工率', '有帮助率', '平均评分', '后台任务：每晚拉进来的对话轮数'])
  // 默认最近 28 天：线上 28 个桶，x 轴头中尾三个日期
  assert.equal(asked.at(-1).granularity, 'day')
  assert.equal(await charts.nth(0).locator('.hdChartAxis').count(), 3)
  // 有帮助率第 3 天没票：路径断成两段（两个 M），不是画到 0
  const helpful = await charts.nth(4).locator('path.hdChartLine').getAttribute('d')
  assert.equal(helpful.match(/M/g).length, 2)
  // 评分轴固定 1 到 5，比率轴从 0%
  assert.deepEqual(await charts.nth(5).locator('.hdChartRule text').allTextContents(), ['1', '3', '5'])
  assert.equal((await charts.nth(1).locator('.hdChartRule text').allTextContents())[0], '0%')
  // 表格视图还在：默认收起，点开能看
  const trendTable = page.getByRole('table', { name: '趋势' })
  assert.equal(await trendTable.isVisible(), false)
  await page.getByText('查看趋势表格').click()
  await trendTable.waitFor()
  assert.equal(await trendTable.locator('tbody tr').count(), 28)
  await shot(page, 'data-charts')
  // 换成按周：重新取数
  await page.getByLabel('周期').selectOption('week')
  await page.waitForFunction(() => document.querySelectorAll('figure.hdChart').length === 7)
  await page.waitForTimeout(200)
  assert.equal(asked.at(-1).granularity, 'week')
  assert.deepEqual(errors, [])
  await page.close()
})

test('hover and arrow keys show the bucket, value and parts; background job strip marks the failed day', async () => {
  const { page, errors } = await open('/zh-CN/help-desk?tab=data')
  const solved = page.locator('figure.hdChart').nth(1)
  await solved.locator('path.hdChartLine').waitFor()
  const plot = solved.locator('.hdChartPlot')
  const box = await plot.boundingBox()
  await page.mouse.move(box.x + box.width - 14, box.y + box.height / 2)
  const tip = solved.locator('.hdChartTip')
  await tip.waitFor()
  assert.match(await tip.innerText(), /\d+%/)
  assert.match(await tip.innerText(), /中的/)
  await page.mouse.move(0, 0)
  await tip.waitFor({ state: 'detached' })
  // 键盘：聚焦后左右键
  await plot.focus()
  await page.keyboard.press('ArrowRight')
  await tip.waitFor()
  const first = await tip.innerText()
  await page.keyboard.press('ArrowRight')
  assert.notEqual(await tip.innerText(), first)
  await page.keyboard.press('Escape')
  await tip.waitFor({ state: 'detached' })
  // 后台任务：10 天，1 天失败；失败的那天线断开
  const job = page.locator('figure.hdChart').nth(6)
  assert.equal(await job.locator('.hdRunMark').count(), 10)
  assert.equal(await job.locator('.hdRunMark-failed').count(), 1)
  assert.equal(await job.locator('.hdRunMark-failed').innerText(), '✕')
  assert.match(await job.locator('.hdRunMark-failed').getAttribute('aria-label'), /失败 · PORTAL_UNAVAILABLE/)
  assert.match(await job.locator('.hdRunStripLabel').innerText(), /最近 10 天里有 1 天失败/)
  assert.equal((await job.locator('path.hdChartLine').getAttribute('d')).match(/M/g).length, 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('en-GB labels, and the page survives when metrics cannot be read', async () => {
  const { page, errors } = await open('/en-GB/help-desk?tab=data', { metricsDown: true })
  await page.locator('.hdFaqError').waitFor()
  assert.equal(await page.locator('figure.hdChart').count(), 0)
  await page.close()
  const second = await open('/en-GB/help-desk?tab=data', { viewport: { width: 1280, height: 800 } })
  await second.page.locator('figure.hdChart').first().waitFor()
  assert.equal(await second.page.locator('.hdChartTitle').first().innerText(), 'Questions (turns)')
  assert.match(await second.page.locator('.hdRunStripLabel').innerText(), /1 of the last 10 days failed/)
  // 1280 宽：图不横向溢出
  const overflow = await second.page.evaluate(() => [...document.querySelectorAll('figure.hdChart')].some((f) => f.scrollWidth > f.clientWidth + 1))
  assert.equal(overflow, false)
  await shot(second.page, 'data-charts-1280-en')
  assert.deepEqual([...errors, ...second.errors], [])
  await second.page.close()
})
