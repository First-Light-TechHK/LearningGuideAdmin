// 浏览器 E2E（真 Chromium + Vite dev server，API 全部在浏览器里假装）：锁住 HelpDesk 对齐 Figma 的几处，
// 和 jsdom 测不到的行为（inert 下的焦点）。
// ① FAQs 表格（Figma 1379:2）五列宽 47.2 / 19 / 8 / 12.9 / 12.9 %，操作列只有 Edit 和 Preview；
// ② 问题树从 Preview 进入：按钮名字就是看得到的字，Preview 关掉、树打开，树关上焦点回到那一行的 Preview 按钮；
// ③ 工单详情的标签按位置上色（Figma 1324:2）：蓝、橙、绿，再从蓝开始。
// 运行：npm run test:e2e:helpdesk（本地跑，CI 不装浏览器；Chromium 用 Playwright 自带的）。
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
  const address = server.httpServer.address()
  base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const ALL = { claim: false, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: true, flag: true }
const TICKET_ID = '0190f000-0000-7000-8000-000000000001'
const TICKET = {
  id: TICKET_ID,
  number: 'LG-261028-0001',
  subject: 'Cannot log in to my account',
  category: 'technical_support',
  status: 'ASSIGNED',
  locale: 'en-GB',
  learner: { id: 'u0', email: 'emily.carter@example.com', name: 'Emily Carter' },
  contactEmail: 'emily.carter@example.com',
  preview: 'I am unable to log in to my account.',
  unreadByAgent: false,
  tags: ['login issue', 'account access', 'payment', 'material access'],
  needsReply: false,
  assignee: { id: 'e1', name: 'Jack' },
  sequence: 2,
  createdAt: '2026-10-28T14:32:00Z',
  updatedAt: '2026-10-28T14:32:00Z',
  lastMessageAt: '2026-10-28T14:32:00Z',
  lastMessageBy: 'learner',
  flagged: false,
  available: ALL,
}
const DETAIL = {
  ...TICKET,
  student: { id: 'u0', name: 'Emily Carter', accountEmail: TICKET.contactEmail, contactEmail: TICKET.contactEmail, joinedAt: '2024-01-15T00:00:00Z', totalEnquiries: 1, currentCourse: null },
  subscription: null,
  events: [],
  aiAssist: [],
  messages: [{ id: 'm1', authorKind: 'learner', authorName: 'Emily Carter', body: TICKET.preview, internal: false, attachments: [], createdAt: TICKET.createdAt }],
}
const FAQS = [
  ['How do I reset my password?', '如何重置密码？', 'account_technical', true],
  ['How do I change my subscription?', '如何更改订阅？', 'payments_subscriptions', false],
].map(([questionEn, questionZh, category, popular], i) => ({
  id: `f${i + 1}`, key: `f${i + 1}`, type: 'answer', entry: true, category, popular, questionEn, questionZh,
  answerEn: 'Open **Settings**.', answerZh: '打开**设置**。', keywords: [], status: 'published', version: 1,
  createdBy: 'e1', updatedBy: 'e1', createdAt: '2026-10-28T08:00:00Z', updatedAt: '2026-10-28T08:00:00Z',
}))
const TREE = {
  root: {
    node: { id: 'f1', key: 'f1', type: 'answer', entry: true, category: 'account_technical', questionEn: FAQS[0].questionEn, questionZh: FAQS[0].questionZh, status: 'published' },
    edge: null, label: null, depth: 0, parentCount: 0, alsoAppearsIn: [], warnings: [], cycle: false, truncated: false, children: [],
  },
  nodes: 1,
}
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })

function reply(url) {
  if (url.pathname === '/api/session')
    return ok({ employee: { employeeId: 'e1', loginEmail: 'jack@example.com', role: 'ADMIN', displayName: 'Jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' })
  if (url.pathname === '/api/helpdesk/tickets') return ok({ tickets: [TICKET], nextCursor: null, counts: {} })
  if (url.pathname === `/api/helpdesk/tickets/${TICKET_ID}`) return ok(DETAIL)
  if (url.pathname === '/api/helpdesk/faqs') return ok({ faqs: FAQS, total: FAQS.length, page: 1, pageSize: 10 })
  if (/^\/api\/helpdesk\/faqs\/[^/]+\/tree$/.test(url.pathname)) return ok(TREE)
  return ok({})
}

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } })
  // 只拦 /api/：Vite 自己的 /src/api/*.ts 模块不能被拦
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill(reply(new URL(route.request().url()))))
  await page.goto(`${base}${path}`)
  return page
}

test('FAQs table: the Figma 1379:2 column widths, and the action cell holds Edit and Preview only', async () => {
  const page = await open('/en-GB/help-desk?tab=faqs')
  await page.locator('.hdFaqTable tbody tr').first().waitFor()
  const widths = await page.locator('.hdFaqTable').evaluate((table) => {
    const total = table.getBoundingClientRect().width
    return [...table.querySelectorAll('thead th')].map((th) => Math.round((th.getBoundingClientRect().width / total) * 1000) / 10)
  })
  const figma = [47.2, 19, 8, 12.9, 12.9]
  assert.equal(widths.length, figma.length)
  widths.forEach((width, i) => assert.ok(Math.abs(width - figma[i]) <= 0.3, `column ${i + 1}: ${width}% vs Figma ${figma[i]}%`))
  const actions = page.locator('.hdFaqTable tbody tr').first().locator('td').last().getByRole('button')
  assert.deepEqual(await actions.allTextContents(), ['Edit', 'Preview'])
  await page.close()
})

for (const [locale, label] of [['en-GB', 'View question tree'], ['zh-CN', '查看问题树']]) {
  test(`${locale}: the question tree opens from Preview; closing it returns focus to the row's Preview button`, async () => {
    const page = await open(`/${locale}/help-desk?tab=faqs`)
    const row = page.locator('.hdFaqTable tbody tr').first()
    await row.waitFor()
    const previewButton = row.locator('.hdFaqPreview')
    await previewButton.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('dialog').filter({ has: page.locator('.hdPreviewFoot') })
    await preview.waitFor()
    await preview.getByRole('button', { name: label, exact: true }).click()
    const tree = page.locator('.hdTreeDrawer')
    await tree.waitFor()
    assert.equal(await page.locator('.hdPreviewFoot').count(), 0, 'the preview closed')
    await tree.locator('.hdTreeRow').first().waitFor()
    await page.keyboard.press('Escape')
    await tree.waitFor({ state: 'detached' })
    // 页面在 Preview 打开时是 inert 的：焦点不能丢到 <body>
    await page.waitForFunction(() => document.activeElement?.classList.contains('hdFaqPreview') ?? false)
    assert.equal(await previewButton.evaluate((node) => node === document.activeElement), true)
    await page.close()
  })
}

test('enquiry tags take the Figma 1324:2 colours by position: blue, orange, green, then blue', async () => {
  const page = await open(`/en-GB/help-desk/${TICKET_ID}`)
  const tags = page.locator('.hdTag')
  await tags.first().waitFor()
  const colours = await tags.evaluateAll((nodes) => nodes.map((node) => [node.textContent?.trim(), getComputedStyle(node).backgroundColor, getComputedStyle(node).color]))
  assert.deepEqual(colours, [
    ['login issue', 'rgb(239, 246, 255)', 'rgb(20, 110, 255)'],
    ['account access', 'rgb(255, 247, 237)', 'rgb(234, 88, 12)'],
    ['payment', 'rgb(240, 253, 244)', 'rgb(22, 163, 74)'],
    ['material access', 'rgb(239, 246, 255)', 'rgb(20, 110, 255)'],
  ])
  await page.close()
})
