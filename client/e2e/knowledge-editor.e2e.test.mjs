import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const imageUrl = '/api/files/images/k1/diagram.png'
const richTable = `<div class="joplin-table-wrapper"><table><tr><td><p>阅读时间</p><ol><li>虎先锋<img src="${imageUrl}"></li></ol></td><td>第21回</td></tr></table></div>`
const course = { id: 'k1', title: '回归课程', externalId: null, description: null }
let server, browser, base, spreadsheet

before(async () => {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  const XLSX = serverRequire('xlsx')
  const { MarkItDown } = serverRequire('markitdown-ts')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['名称', '备注'], ['唐僧', 'first\nsecond'], ['悟空', 'A|B']]), '工作表')
  const converted = await new MarkItDown().convertBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { file_extension: '.xlsx' })
  spreadsheet = converted.markdown
})

after(async () => {
  await browser?.close()
  await server?.close()
})

async function open(contentMd = '测试正文\n\n末尾') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const errors = []
  const uploads = []
  const node = { id: 'p1', title: '回归页面', contentMd, sectionTags: {}, sortOrder: 0, syncState: 'SYNCED' }
  const ok = (data) => ({ contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') return route.fulfill(ok({ employee: { employeeId: 'e1', loginEmail: 'test@example.com', role: 'ADMIN', displayName: 'Test', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED' }, sidebarState: 'expanded' }))
    if (path === '/api/courses') return route.fulfill(ok([course]))
    if (path === '/api/courses/k1') return route.fulfill(ok({ ...course, pages: [node] }))
    if (path === '/api/pages/p1') return route.fulfill(ok(node))
    if (path === '/api/files/images/k1') {
      uploads.push(route.request().postDataBuffer().toString())
      return route.fulfill(ok({ url: imageUrl }))
    }
    if (path === imageUrl) return route.fulfill({ contentType: 'image/png', body: png })
    if (path === '/api/files/convert') return route.fulfill(ok({ title: '阅读任务', markdown: richTable }))
    return route.fulfill(ok([]))
  })
  await page.goto(`${base}/zh-CN/knowledge`)
  await page.waitForLoadState('networkidle')
  await page.getByText('回归页面', { exact: true }).click()
  await page.locator('.cm-editor').waitFor()
  return { context, page, errors, uploads }
}

async function currentMarkdown(page) {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+a')
  return page.locator('.cm-content').evaluate((content) => {
    const copy = content.cloneNode(true)
    copy.querySelectorAll('.cm-placeholder').forEach((element) => element.remove())
    return [...copy.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n').trimEnd()
  })
}

test('right-click image insertion shows the upload limit and renders both images without Enter', async () => {
  const { context, page, errors, uploads } = await open()
  const openImageMenu = async () => {
    await page.locator('.cm-content').click({ button: 'right', position: { x: 50, y: 15 } })
    await page.getByRole('menuitem', { name: /插入图片/ }).click()
  }
  try {
    assert.equal(await page.getByRole('button', { name: '图片', exact: true }).count(), 0)
    await openImageMenu()
    await page.getByRole('menuitem', { name: '本地上传', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText(/20 MiB/).waitFor()
    await page.locator('input[type=file][accept*=".heic"]').setInputFiles({
      name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 ** 2 + 1),
    })
    await page.getByText(/超过单张 20 MiB/).waitFor()
    assert.equal(uploads.length, 0)
    await page.locator('.ant-modal-confirm').getByRole('button').click()
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: '选择图片' }).click()
    await (await chooser).setFiles({ name: '本地图.png', mimeType: 'image/png', buffer: png })
    await page.locator(`.cm-editor img[src="${imageUrl}"]`).waitFor()
    assert.equal(uploads.length, 1)
    await dialog.waitFor({ state: 'hidden' })

    await page.route('https://images.example.test/example.png', (route) => route.fulfill({ body: png, contentType: 'image/png' }))
    await openImageMenu()
    await page.getByRole('menuitem', { name: '外链图片', exact: true }).click()
    await dialog.getByRole('textbox', { name: '外链图片' }).fill('https://images.example.test/example.png')
    await dialog.getByRole('button', { name: /创\s*建/ }).click()
    await page.locator('.cm-editor img[src="https://images.example.test/example.png"]').waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-editor img')].some((img) => img.complete && img.naturalWidth > 0))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('five empty inline formats cancel on repeated toolbar clicks', async () => {
  const { context, page, errors } = await open('')
  try {
    for (const label of ['B', 'I', 'S', '</>', '$x$']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await button.click()
      await button.click()
      assert.equal(await currentMarkdown(page), '')
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('real XLSX conversion survives ten triple-click and edit-exit cycles', async () => {
  const { context, page, errors } = await open(`${spreadsheet}\n\n末尾`)
  try {
    const widths = []
    for (let i = 0; i < 10; i++) {
      const table = page.locator('.cm-md-table-widget')
      await table.locator('td').first().click({ clickCount: 3 })
      await table.locator('.cm-md-table-cell-edit').first().waitFor()
      await table.locator('.cm-md-table-cell-edit').first().click({ clickCount: 3 })
      await table.locator('.cm-md-table-tbtn-primary').click()
      widths.push((await table.boundingBox()).height)
      assert.equal(await table.locator('tr').count(), 4)
    }
    assert.ok(Math.max(...widths) - Math.min(...widths) < 2, JSON.stringify(widths))
    const result = await currentMarkdown(page)
    assert.ok(result.includes('唐僧') && result.includes('first') && result.includes('second'))
    assert.ok(result.length < spreadsheet.length + 100)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('DOCX HTML table and upload preview display loaded images', async () => {
  const { context, page, errors } = await open(`${richTable}\n\n末尾`)
  try {
    await page.locator('.cm-md-table-widget img').waitFor()
    await page.waitForFunction(() => [...document.images].some((img) => img.naturalWidth > 0))
    await page.locator('.cm-md-table-widget td').first().click()
    await page.locator('.cm-md-table-widget img').waitFor()
    await page.getByRole('button', { name: '编辑表格源码' }).click()
    await page.locator('.cm-content').getByText('joplin-table-wrapper', { exact: false }).waitFor()
    await page.locator('.anticon-more').first().click()
    await page.getByRole('menuitem', { name: '上传文档建页' }).click()
    await page.locator('.ant-upload input[type=file]').setInputFiles({ name: '阅读任务.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('mock upload') })
    await page.getByRole('button', { name: /下一步/ }).click()
    await page.locator('.ant-modal img').waitFor()
    assert.equal(await page.locator('.ant-modal table').count(), 1)
    assert.equal(await page.locator('.ant-modal pre').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
