import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('teaching sidebar reveals only clipped titles on the right and keeps adjacent entries clickable', async () => {
  const long = '三维状态向量 · Shark–tuna–plankton system as a state vector with population time arguments'
  const cards = [long, '向量加法'].map((title, i) => ({
    id: 'f' + i, createdAt: null, additionPosition: i, revision: 1, approvedRevision: 1,
    draft: { type: 'ref_obj', conceptId: 'f' + i, topic: '*', useWhen: ['*'], evidence: [], links: [],
      bilingual: { conceptLabel: { zh: title, en: '' }, summary: { zh: '', en: '' }, triggers: { zh: [], en: [] } },
      approvedPayload: { displayName: title, refObjects: [{ kind: 'latex', value: 'x+y' }] } },
  }))
  const server = process.env.BACKOFFICE_TEST_BASE_URL ? null : await createServer({ logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
  let browser
  try {
    await server?.listen()
    const base = process.env.BACKOFFICE_TEST_BASE_URL ?? 'http://127.0.0.1:' + server.httpServer.address().port
    browser = await chromium.launch({ args: ['--disable-gpu', '--renderer-process-limit=1'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.setDefaultTimeout(9000)
    const course = { id: 'k1', title: 'Course', externalId: null, description: null, pages: [] }
    await page.route(url => url.pathname.startsWith('/api/'), route => {
      const path = new URL(route.request().url()).pathname
      const data = path === '/api/session' ? { employee: { employeeId: 'e1', loginEmail: 'test@example.com', role: 'ADMIN', displayName: 'Test', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED' } }
        : path === '/api/courses' ? [course] : path === '/api/courses/k1/teaching-cards' ? cards : path === '/api/courses/k1' ? course : []
      return route.fulfill({ json: { success: true, data, error: null } })
    })
    await page.goto(base + '/zh-CN/knowledge?tab=teaching&courseId=k1')
    const card = page.getByRole('button', { name: new RegExp(long) })
    const short = page.getByRole('button', { name: /向量加法/ })
    const tip = page.getByRole('tooltip')
    await card.hover()
    await short.hover()
    await page.waitForTimeout(550)
    assert.equal(await tip.isVisible(), false)
    await card.hover()
    await tip.waitFor({ state: 'visible' })
    const box = await card.boundingBox()
    const popup = await tip.boundingBox()
    assert.ok(popup.x >= box.x + box.width - 2)
    assert.equal(await tip.textContent(), long)
    await short.click()
    await page.getByRole('button', { name: /向量加法/, pressed: true }).waitFor()
    await card.focus()
    await tip.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'hidden' })
  } finally { await browser?.close(); await server?.close() }
})
