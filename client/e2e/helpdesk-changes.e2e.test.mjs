// 浏览器 E2E（真 Chromium + Vite dev server，API 全部在浏览器里假装）：锁住修改记录（Figma 草案 2.6–2.9，
// 用户 2026-10-30 确认）里 jsdom 测不到的部分：
// ① Change Log 表格五列宽 180 / 220 / 470 / 333 / 100（13.8 / 16.9 / 36 / 25.6 / 7.7 %），页面不横向滚动；
// ② 改动详情从「View details」打开，Escape 关掉后焦点回到那个按钮（页面在抽屉打开时是 inert 的）；
// ③ FAQ 抽屉三个页签，History（N）展开改动；「Open in Change Log」关掉抽屉、地址栏只看这一条；
// 运行：npm run test:e2e:helpdesk（本地跑，CI 不装浏览器）。E2E_SHOTS=<目录> 时保存截图，用来对照 Figma。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const shots = process.env.E2E_SHOTS
let server
let browser
let base

before(async () => {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const FAQ_ID = '0192aaaa-0000-7000-8000-0000000000f1'
const JACK = { id: '0192aaaa-0000-7000-8000-0000000000e1', name: 'jack', role: 'ADMIN', email: 'jack@example.com' }
const MIA = { id: '0192aaaa-0000-7000-8000-0000000000e2', name: 'mia.chen', role: 'OPERATION_ADMIN', email: 'mia.chen@example.com' }
const NODE = { id: FAQ_ID, key: 'reset-password', questionEn: 'How do I reset my password?', questionZh: '如何重置密码？', status: 'published' }
const CHILD = { id: '0192aaaa-0000-7000-8000-0000000000f2', key: 'no-email', questionEn: 'I did not get the reset email', questionZh: '没收到重置邮件', status: 'published' }
const FAQ = {
  ...NODE, type: 'answer', entry: true, signals: [], category: 'account_technical', popular: true,
  answerEn: 'Select “Forgot password”. The link expires after 30 minutes; check your spam folder.', answerZh: '点击“忘记密码”。',
  keywords: ['reset password', 'reset link'], version: 5, createdBy: JACK.id, updatedBy: JACK.id,
  createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-30T08:20:00Z',
}
const base0 = { faq: NODE, child: null, phrasing: null, release: null, version: null, changes: [], learners: 'live', liveIn: 12 }
const CHANGES = [
  {
    ...base0, id: 'faq:5', at: '2026-10-30T08:20:05Z', employee: JACK, subject: 'faq', action: 'edited', version: { from: 4, to: 5 },
    learners: 'pending', liveIn: null,
    changes: [
      { field: 'answerEn', before: 'Select “Forgot password”. If no email arrives, check your spam folder.', after: FAQ.answerEn },
      { field: 'keywords', before: ['reset password', 'cannot log in'], after: FAQ.keywords },
    ],
  },
  { ...base0, id: 'edge:1', at: '2026-10-30T08:12:00Z', employee: JACK, subject: 'follow_up', action: 'added', child: CHILD, changes: [{ field: 'kind', before: null, after: 'follow_up' }, { field: 'position', before: null, after: 1 }] },
  { ...base0, id: 'phrasing:1', at: '2026-10-30T07:58:00Z', employee: MIA, subject: 'phrasing', action: 'removed', phrasing: { locale: 'zh-CN', text: '忘记密码怎么办', source: 'staff' } },
  { ...base0, id: 'release_published:12', at: '2026-10-30T07:40:00Z', employee: MIA, subject: 'release', action: 'published', faq: null, learners: null, liveIn: null, release: { version: 12, status: 'published', sourceVersion: null, problems: 0 } },
]
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })

function reply(url) {
  if (url.pathname === '/api/session')
    return ok({ employee: { employeeId: JACK.id, loginEmail: JACK.email, role: 'ADMIN', displayName: 'jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' })
  if (url.pathname === '/api/helpdesk/tickets') return ok({ tickets: [], nextCursor: null, counts: {} })
  if (url.pathname === '/api/helpdesk/faq-changes') {
    const only = url.searchParams.get('faq')
    const rows = CHANGES.filter((c) => !only || c.faq?.id === only || c.child?.id === only)
    return ok({ changes: rows, total: rows.length, page: 1, pageSize: 10, people: [JACK, MIA] })
  }
  if (url.pathname === '/api/helpdesk/faqs') return ok({ faqs: [FAQ], total: 1, page: 1, pageSize: 10 })
  if (url.pathname === `/api/helpdesk/faqs/${FAQ_ID}`) return ok(FAQ)
  if (url.pathname === `/api/helpdesk/faqs/${FAQ_ID}/edges`) return ok({ children: [], parents: [] })
  if (url.pathname === `/api/helpdesk/faqs/${FAQ_ID}/phrasings`) return ok({ phrasings: [] })
  if (url.pathname === `/api/helpdesk/faqs/${FAQ_ID}/changes`) return ok({ changes: CHANGES, total: CHANGES.length, page: 1, pageSize: 50, truncated: false })
  return ok({})
}

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } })
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill(reply(new URL(route.request().url()))))
  await page.goto(`${base}${path}`)
  return page
}

async function shot(page, name) {
  // 等抽屉的进场动画（0.18s）播完再截，不然截到半透明的一帧
  if (shots) await page.waitForTimeout(400)
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false })
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test('Change Log table: the Figma 2.6 column widths; no horizontal page scroll', async () => {
  const page = await open('/en-GB/help-desk?tab=changes')
  await page.locator('.hdChangesTable tbody tr').first().waitFor()
  const widths = await page.locator('.hdChangesTable').evaluate((table) => {
    const total = table.getBoundingClientRect().width
    return [...table.querySelectorAll('thead th')].map((th) => Math.round((th.getBoundingClientRect().width / total) * 1000) / 10)
  })
  const figma = [13.8, 16.9, 36, 25.6, 7.7]
  widths.forEach((width, i) => assert.ok(Math.abs(width - figma[i]) <= 0.4, `column ${i + 1}: ${width}% vs Figma ${figma[i]}%`))
  assert.equal(await noSideScroll(page), true)
  await shot(page, '2.6-change-log')
  await page.close()
})

test('change details: opens from View details; Escape returns focus to that button', async () => {
  const page = await open('/en-GB/help-desk?tab=changes')
  const button = page.getByRole('button', { name: 'View details: Edited, How do I reset my password?' })
  await button.click()
  const details = page.getByRole('dialog', { name: 'Change details' })
  await details.waitFor()
  assert.equal(await details.locator('del', { hasText: 'If no email arrives,' }).count(), 1)
  assert.equal(await details.locator('ins', { hasText: 'The link expires after 30 minutes;' }).count(), 1)
  await shot(page, '2.7-change-details')
  await page.keyboard.press('Escape')
  await details.waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.classList.contains('hdChangesView') ?? false)
  assert.equal(await button.evaluate((node) => node === document.activeElement), true)
  await page.close()
})

test('FAQ drawer: three tabs, History (4) with the diff, Open in Change Log shows only this FAQ', async () => {
  const page = await open('/en-GB/help-desk?tab=faqs')
  await page.getByRole('button', { name: `Edit ${FAQ.questionEn}` }).click()
  const drawer = page.getByRole('dialog', { name: 'Edit FAQ' })
  await drawer.waitFor()
  await drawer.getByRole('tab', { name: 'History (4)' }).waitFor()
  await drawer.getByRole('tab', { name: 'Follow-ups & phrasings' }).click()
  await shot(page, '2.9-follow-ups')
  await drawer.getByRole('tab', { name: 'History (4)' }).click()
  await drawer.getByRole('button', { name: 'View changes' }).first().click()
  assert.equal(await drawer.locator('.hdHistoryDiff ins', { hasText: 'reset link' }).count(), 1)
  await shot(page, '2.8-history')
  await drawer.getByRole('button', { name: 'Open in Change Log' }).click()
  await drawer.waitFor({ state: 'detached' })
  await page.getByText('Changes to: How do I reset my password?').waitFor()
  assert.match(page.url(), new RegExp(`tab=changes&range=all&faq=${FAQ_ID}$`))
  await page.close()
})
