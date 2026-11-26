// Requires an isolated Admin server and E2E_EMAIL/E2E_PASSWORD for its test account.
const { chromium } = require('playwright')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD) throw new Error('Set isolated E2E credentials')
  const { createServer } = await import('vite')
  const server = await createServer({
    root: path.resolve(__dirname, '..'), logLevel: 'error',
    server: { port: 0, host: '127.0.0.1', proxy: { '/api': { target: process.env.E2E_API || 'http://127.0.0.1:3013', changeOrigin: true } } },
  })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--headless=new', '--no-sandbox'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    await page.goto(`${base}/en-GB/sign-in`)
    await page.locator('#sign-in-email').fill(process.env.E2E_EMAIL)
    await page.locator('#sign-in-password').fill(process.env.E2E_PASSWORD)
    await page.locator('form button[type=submit]').click()
    await page.waitForURL(/\/en-GB\/course/, { timeout: 90000 })
    const created = await context.request.post(`${base}/api/backoffice/courses`, { data: {
      titles: { 'en-GB': 'Cover and pricing QA', 'zh-CN': '封面套餐测试' }, learningMode: 'VIDEO_ONLY',
      defaultContentLanguage: 'en-GB', learningLanguages: ['en-GB', 'zh-CN'],
    } })
    assert.equal(created.status(), 201)
    const id = (await created.json()).data.id
    await page.goto(`${base}/en-GB/course/${id}`)
    await page.getByTestId('info-course-id').waitFor({ timeout: 90000 })
    for (const [width, height] of [[100, 300], [700, 100]]) {
      const data = await page.evaluate(([w, h]) => {
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, w, h)
        return canvas.toDataURL('image/png').split(',')[1]
      }, [width, height])
      const pending = page.waitForResponse(r => r.url().endsWith('/cover') && r.request().method() === 'POST').catch(() => null)
      await page.locator('input[type=file]:enabled').first().waitFor({ state: 'attached' })
      const input = page.locator('input[type=file]').first()
      if (width === 100) {
        await page.evaluate(() => {
          const decode = window.createImageBitmap
          window.createImageBitmap = async (...args) => {
            window.createImageBitmap = decode
            await new Promise(resolve => { window.resumeQaCoverDecode = resolve })
            return decode.apply(window, args)
          }
        })
      }
      await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') })
      if (width === 100) {
        await page.waitForFunction(() => typeof window.resumeQaCoverDecode === 'function')
        try {
          assert.equal(await input.isDisabled(), true, 'cover selection stays disabled during image decoding')
        } finally {
          await page.evaluate(() => window.resumeQaCoverDecode())
        }
      }
      assert.ok([200, 201].includes((await pending)?.status()))
      const actual = await page.evaluate(async courseId => {
        const response = await fetch(`/api/backoffice/courses/${courseId}/cover`, { cache: 'no-store' })
        const image = await createImageBitmap(await response.blob())
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        return { width: image.width, height: image.height, center: [...ctx.getImageData(200, 92, 1, 1).data], corner: [...ctx.getImageData(0, 0, 1, 1).data] }
      }, id)
      assert.deepEqual([actual.width, actual.height], [400, 185])
      assert.deepEqual(actual.center, [255, 0, 0, 255])
      assert.deepEqual(actual.corner, [255, 255, 255, 255])
      await page.locator('input[type=file]:enabled').first().waitFor({ state: 'attached' })
      const previewEdge = await page.locator('img[src*="/cover?asset="]').evaluate(async img => {
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = 400; canvas.height = 185
        const context = canvas.getContext('2d'); context.drawImage(img, 0, 0)
        return [...context.getImageData(10, 92, 1, 1).data]
      })
      assert.deepEqual(previewEdge, width === 100 ? [255, 255, 255, 255] : [255, 0, 0, 255])
    }
    await page.reload()
    const cover = page.locator('img[src*="/cover?asset="]')
    await cover.waitFor()
    if (process.env.E2E_SHOTS) {
      require('node:fs').mkdirSync(process.env.E2E_SHOTS, { recursive: true })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await cover.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `cover-${width}.png`) })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
    await page.getByRole('button', { name: /Trial/ }).first().click()
    await page.getByTestId('trial-pricing').waitFor()
    await page.getByRole('button', { name: '+ Add plan' }).click()
    const rows = page.getByTestId('trial-plans').locator('tbody tr')
    await rows.nth(0).locator('input').first().fill('One month')
    await page.getByRole('button', { name: '+ Add plan' }).click()
    await rows.nth(1).locator('input').first().fill('Three months')
    await rows.nth(1).locator('select').selectOption('3')
    await rows.nth(1).locator('input').nth(1).fill('25.00')
    const saved = page.waitForResponse(r => r.url().endsWith('/plans') && r.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save & sync Stripe' }).click()
    assert.equal((await saved).status(), 200)
    await page.reload()
    await page.getByRole('button', { name: /Trial/ }).first().click()
    await rows.nth(1).waitFor()
    assert.equal(await rows.nth(0).locator('input').first().inputValue(), 'One month')
    assert.equal(await rows.nth(1).locator('input').first().inputValue(), 'Three months')
    assert.equal(await rows.nth(0).locator('input').nth(1).inputValue(), '10.00')
    assert.equal(await rows.nth(1).locator('input').nth(1).inputValue(), '25.00')
    console.log('PASS: both cover shapes and both saved plans after reload')
  } finally {
    await browser.close()
    await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
