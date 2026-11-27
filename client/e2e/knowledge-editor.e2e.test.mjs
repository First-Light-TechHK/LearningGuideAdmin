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

async function open(contentMd = '测试正文\n\n末尾', releases = [], locale = 'zh-CN') {
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
    if (path === '/api/courses/k1/releases') return route.fulfill(ok(releases))
    if (path === '/api/pages/p1') return route.fulfill(ok(node))
    if (path === '/api/files/images/k1') {
      uploads.push(route.request().postDataBuffer().toString())
      return route.fulfill(ok({ url: imageUrl }))
    }
    if (path === imageUrl) return route.fulfill({ contentType: 'image/png', body: png })
    if (path === '/api/files/convert') return route.fulfill(ok({ title: '阅读任务', markdown: richTable }))
    return route.fulfill(ok([]))
  })
  await page.goto(`${base}/${locale}/knowledge`)
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

test('course references can be inserted into the selected text and previewed from either entry point', async () => {
  const { context, page, errors } = await open('替换这行\n\n尾部内容')
  const asset = '12345678-aaaa-bbbb-cccc-123456789012.png'
  const image = `/api/files/images/k1/${asset}`
  const references = [
    { id: 'diagram', kind: 'image', label: '状态空间示意图', value: asset, requires: [] },
    { id: 'square', kind: 'latex', code: 'L1-F01', label: '平方公式', value: 'x^2', requires: [] },
    ...Array.from({ length: 18 }, (_, i) => ({ id: 'extra-' + i, kind: 'latex', code: 'Extra-' + i, label: '补充公式', value: 'x+' + i, requires: [] })),
  ]
  try {
    let requests = 0
    let valid = false
    await page.route('**/api/courses/k1/teaching-references', (route) => {
      requests++
      return route.fulfill({ status: valid ? 200 : 503, json: valid
        ? { success: true, data: references, error: null }
        : { success: false, data: null, error: { code: 'SCHEMA_NOT_READY', message: 'SCHEMA_NOT_READY' } } })
    })
    await page.route(`**${image}`, (route) => route.fulfill({ body: png, contentType: 'image/png' }))
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Shift+End')
    await page.getByRole('button', { name: '课程引用', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '插入引用' })
    await dialog.getByText('数据库版本未就绪，请管理员检查部署迁移。').waitFor()
    valid = true
    await dialog.getByRole('button', { name: /重\s*试/ }).click()
    const search = dialog.getByRole('textbox', { name: '搜索引用名称或课程内编号' })
    const choices = dialog.getByRole('radiogroup')
    await choices.waitFor()
    assert.equal(await choices.getByRole('radio').count(), 20)
    const modalHeight = () => dialog.locator('.ant-modal-content').evaluate(el => el.offsetHeight)
    const fullHeight = await modalHeight()
    assert.equal(await choices.evaluate(list => list.clientHeight / list.firstElementChild.offsetHeight), 5)
    await choices.getByRole('radio').nth(5).check()
    assert.ok(await choices.evaluate(list => list.scrollTop > 0))
    assert.equal(await modalHeight(), fullHeight)
    const confirm = dialog.getByRole('button', { name: '插入引用', exact: true })
    await search.fill('无匹配结果')
    assert.ok(await confirm.isDisabled())
    assert.equal(await modalHeight(), fullHeight)
    await dialog.getByRole('button', { name: '清空搜索' }).click()
    assert.equal(await choices.locator('input:checked').count(), 0)
    await search.fill('示意图')
    await choices.getByRole('radio', { name: /状态空间示意图/ }).check()
    await dialog.locator(`img[src="${image}"]`).waitFor()
    assert.equal(await modalHeight(), fullHeight)
    await dialog.getByRole('button', { name: '插入引用', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await currentMarkdown(page), '[状态空间示意图](refobj:diagram)\n\n尾部内容')

    await page.keyboard.press('Control+End')
    await page.locator('.cm-line').last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /课程引用/ }).click()
    await search.fill(' l1-f01 ')
    await choices.getByRole('radio').focus()
    await page.keyboard.press('Space')
    await dialog.locator('.katex').waitFor()
    await dialog.getByRole('button', { name: '插入引用', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.match(await currentMarkdown(page), /\[平方公式\]\(refobj:square\)/)
    await page.getByRole('button', { name: /预\s*览/ }).click()
    await page.locator(`#root .wmde-markdown img[src="${image}"]`).waitFor()
    await page.locator('#root .wmde-markdown .katex').waitFor()
    await page.waitForFunction(() => [...document.images].some((img) => img.alt === '状态空间示意图' && img.naturalWidth > 0))
    assert.ok(requests >= 4)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('professor answer inserts one approved reference on confirmation, independently of the saved draft name', async () => {
  const { context, page } = await open(undefined, [], 'en-GB')
  const draft = {
    type: 'ref_obj', topic: '*', conceptId: 'square', canonicalPoint: 'Square',
    bilingual: { conceptLabel: { zh: '平方', en: 'Square' }, summary: { zh: '', en: 'Square' }, triggers: { en: [], zh: [] } },
    approvedPayload: { code: 'L1-F01', displayName: 'Squared distance', refObjects: [{kind:'latex',value:'x^2'}] },
    useWhen:['*'], doNotUseWhen:[], links:[], evidence:[], priority:10,
  }
  let references = []
  try {
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({ json: { success: true, data: [
      { id:'square', revision:3, approvedRevision:1, draft, approved:{...draft,approvedPayload:{...draft.approvedPayload,displayName:'Square'}} },
    ] } }))
    await page.route('**/api/courses/k1/teaching-references', route => route.fulfill({json:{success:true,data:references}}))
    await page.getByRole('tab', {name:'Teaching entries'}).click()
    await page.getByRole('textbox',{name:'Search entries'}).fill('squared distance')
    await page.getByRole('button', {name:/Squared distance.*Saved/}).click()
    await page.getByText('Save this entry again to include this revision in the next release.').waitFor()
    await page.getByRole('button', {name:'Add entry'}).click()
    const answer = page.getByRole('textbox', {name:'Professor answer'})
    await answer.fill('Use the formula.')
    const openPicker = page.locator('.teaching-answer-insert')
    await openPicker.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText(/no images or formulas/).waitFor()
    await dialog.getByRole('textbox').focus()
    await page.keyboard.press('Escape')
    await dialog.waitFor({state:'hidden'})
    assert.equal(await answer.inputValue(), 'Use the formula.')
    references = [{ id:'square',label:'Square',kind:'latex',code:'L1-F01',value:'x^2',requires:[] }]
    await page.setViewportSize({ width:390,height:660 })
    await openPicker.click()
    await dialog.getByRole('radio', {name:/Square/}).check()
    await dialog.locator('.katex').waitFor()
    assert.equal(await answer.inputValue(), 'Use the formula.')
    const insert = dialog.getByRole('button', {name:'Insert reference'})
    const bounds = await insert.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 660)
    await insert.click()
    assert.equal(await answer.inputValue(), 'Use the formula.\n\n[Square](refobj:square)')
  } finally { await context.close() }
})

test('long bilingual entry titles have padding and cannot overlap the saved badge', async () => {
  const { context, page } = await open()
  const title = 'L3-F04 · 状态的标量缩放 · Scaling multiplication of a state'
  const draft = {
    type:'ref_obj', topic:'*', conceptId:'scaling', canonicalPoint:'scaling',
    bilingual:{conceptLabel:{zh:'状态的标量缩放',en:'Scaling multiplication of a state'},summary:{en:'Scaling',zh:'缩放'},triggers:{en:[],zh:[]}},
    approvedPayload:{code:'L3-F04',refObjects:[{kind:'latex',value:'aX'}]},useWhen:['*'],doNotUseWhen:[],links:[],evidence:[],priority:10,
  }
  try {
    const rows = Array.from({length:14},(_,i)=>({id:'row-'+i,revision:2,approvedRevision:1,draft,approved:draft}))
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({json:{success:true,data:rows}}))
    await page.getByRole('tab',{name:'教学条目'}).click()
    const row = page.locator('.teaching-list-entry').first()
    await row.click()
    const form = page.locator('.teaching-form')
    const remove = await form.getByRole('button', { name: '删除条目' }).boundingBox()
    const save = await form.getByRole('button', { name: '保存草稿' }).boundingBox()
    const bounds = await form.boundingBox()
    assert.ok(remove && save && bounds)
    assert.ok(Math.abs(remove.y - save.y) <= 2 && remove.x > save.x + save.width + 16)
    assert.ok(Math.abs(remove.x + remove.width - bounds.x - bounds.width) <= 2)
    for (const width of [1440, 560]) {
      await page.setViewportSize({width,height:700})
      await row.scrollIntoViewIfNeeded()
      const dims = await row.evaluate(el=>{
        const box = el.getBoundingClientRect()
        const text = el.querySelector('.teaching-entry-title').getBoundingClientRect()
        const meta = el.querySelector('small').getBoundingClientRect()
        const badge = el.querySelector('.ant-tag').getBoundingClientRect()
        return {top:text.top-box.top, bottom:box.bottom-meta.bottom, gap:badge.left-text.right, title:el.querySelector('.teaching-entry-title').textContent}
      })
      assert.equal(dims.title,title)
      assert.ok(dims.top >= 7 && dims.bottom >= 7 && dims.gap >= 7,JSON.stringify(dims))
    }
  } finally {await context.close()}
})

test('rapid teaching list scrolling keeps title tooltips from expanding the page', async () => {
  const { context, page } = await open()
  try {
    const rows = Array.from({ length: 45 }, (_, index) => ({
      id: 'entry-' + index, revision: 1, approved: null, approvedRevision: null,
      draft: { type: 'ref_obj', bilingual: { conceptLabel: { zh: '状态向量', en: 'Four-dimensional state vector' } },
        approvedPayload: { code: 'L3-F' + index, refObjects: [] } },
    }))
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({ json: { success: true, data: rows } }))
    await page.getByRole('tab', { name: '教学条目' }).click()
    const list = page.locator('.teaching-list')
    const last = list.locator('.teaching-list-entry').last()
    await last.hover()
    await page.getByRole('tooltip').filter({ hasText: 'L3-F44' }).waitFor()
    assert.ok(await list.evaluate(el => el.scrollTop > 0))
    const baseline = await page.evaluate(() => document.documentElement.scrollHeight)
    const heights = page.evaluate(() => new Promise(resolve => {
      const samples = []
      function sample() {
        samples.push(document.documentElement.scrollHeight)
        if (samples.length < 40) requestAnimationFrame(sample)
        else resolve(samples)
      }
      sample()
    }))
    await page.mouse.wheel(0, -6000)
    await page.waitForFunction(() => document.querySelector('.teaching-list').scrollTop === 0)
    await page.mouse.wheel(0, 900)
    await page.waitForFunction(() => document.querySelector('.teaching-list').scrollTop > 0)
    assert.equal(Math.max(...await heights), baseline)
  } finally { await context.close() }
})

test('previews two reference documents, filters by lesson and saves only selected drafts', async () => {
  const { context, page } = await open()
  const asset = '00000000-0000-0000-0000-000000000001.png'
  let submitted
  try {
    await page.route('**/api/files/convert?courseId=k1', route => route.fulfill({ json: {
      success: true, data: { title: 'Figures', markdown: '## Exhibit 1.1 星座 · Stars\n![](/api/files/images/k1/' + asset + ')\n\n图注\n\nCaption' },
    } }))
    await page.route('**/api/courses/k1/teaching-cards/import/references', route => {
      submitted = route.request().postDataJSON().items
      assert.equal(route.request().method(), 'POST')
      return route.fulfill({ json: { success: true, data: { saved: submitted.length } } })
    })
    await page.getByRole('tab', { name: '教学条目' }).click()
    const importButton = page.getByRole('button', { name: '从文档导入引用对象' })
    await page.getByRole('button', { name: '新建条目' }).click()
    await page.getByRole('textbox', { name: '学生问题' }).waitFor()
    assert.equal(await importButton.count(), 0)
    await page.getByRole('combobox', { name: '条目类型' }).press('ArrowDown')
    await page.getByText('引用对象', { exact: true }).last().click()
    const typeBox = await page.locator('.teaching-select-row .ant-select').first().boundingBox()
    const buttonBox = await importButton.boundingBox()
    assert.ok(typeBox && buttonBox && buttonBox.x >= typeBox.x + typeBox.width)
    assert.ok(Math.abs(buttonBox.y + buttonBox.height - typeBox.y - typeBox.height) <= 2)
    await importButton.click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type=file]').setInputFiles([
      { name: 'Figures.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture') },
      { name: 'Formula.md', mimeType: 'text/markdown', buffer: Buffer.from('### L3-F01 变化 · Change\n$$\nx+y\n$$\n\n解释\n\nExplanation') },
    ])
    await dialog.getByText('共解析 2 个候选对象').waitFor()
    assert.equal(submitted, undefined)
    await dialog.getByRole('searchbox').fill('Lesson 3')
    await dialog.getByRole('button', { name: '仅勾选筛选结果' }).click()
    assert.match(await dialog.innerText(), /保存所选草稿（1）/)
    await dialog.getByRole('button', { name: '保存所选草稿（1）' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].draft.type, 'ref_obj')
    assert.equal(submitted[0].draft.approvedPayload.code, 'L3-F01')
    assert.deepEqual(submitted[0].draft.approvedPayload.refObjects, [{ kind: 'latex', value: 'x+y' }])
  } finally { await context.close() }
})

test('reimporting the same Word image bytes skips the existing reference draft', async () => {
  const { context, page } = await open()
  const oldAsset = '00000000-0000-0000-0000-000000000001.png'
  const newAsset = '00000000-0000-0000-0000-000000000002.png'
  const draft = {
    type: 'ref_obj', bilingual: { conceptLabel: { zh: '星座', en: 'Stars' }, summary: { zh: '图注', en: 'Caption' } },
    approvedPayload: { code: 'Exhibit 1.1', refObjects: [{ id: 'entry', kind: 'image', value: oldAsset }] },
  }
  try {
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({ json: { success: true, data: [
      { id: 'entry', revision: 3, draft, approved: draft, approvedRevision: 2 },
    ] } }))
    await page.route('**/api/files/images/k1/*.png', route => route.fulfill({ contentType: 'image/png', body: png }))
    await page.route('**/api/files/convert?courseId=k1', route => route.fulfill({ json: {
      success: true, data: { title: 'Figures', markdown: ['## Exhibit 1.1 星座 · Stars', '![](/api/files/images/k1/' + newAsset + ')', '图注', 'Caption'].join('\n\n') },
    } }))
    await page.getByRole('tab', { name: '教学条目' }).click()
    await page.getByRole('button', { name: /Exhibit 1\.1/ }).click()
    await page.getByRole('button', { name: '从文档导入引用对象' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type=file]').setInputFiles({ name: 'Figures.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('fixture') })
    await dialog.getByText('内容相同，跳过').waitFor()
    assert.ok(await dialog.getByRole('checkbox').isDisabled())
    assert.ok(await dialog.getByRole('button', { name: '保存所选草稿（0）' }).isDisabled())
  } finally { await context.close() }
})

test('batch selection shows the checked titles before opening deletion preview', async () => {
  const { context, page } = await open()
  const titles = ['L3-F04 · 状态的标量缩放 · Scaling multiplication of a state', 'L3-F03 · 状态相加 · Addition of two states']
  const rows = titles.map((question, index) => ({
    id: 'entry-' + index, revision: 1, approvedRevision: null, approved: null,
    draft: { type: 'professor_qa', bilingual: { conceptLabel: { zh: question, en: question } },
      approvedPayload: { question, answerMd: 'Answer' } },
  }))
  try {
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({ json: { success: true, data: rows } }))
    await page.route('**/api/courses/k1/teaching-cards/deletion-preview', route => {
      assert.deepEqual(route.request().postDataJSON().items, [{ id: 'entry-1', revision: 1 }])
      return route.fulfill({ json: { success: true, data: { blockers: [] } } })
    })
    await page.getByRole('tab', { name: '教学条目' }).click()
    await page.getByRole('button', { name: '批量管理' }).click()
    const first = page.getByRole('checkbox', { name: titles[0] })
    const second = page.getByRole('checkbox', { name: titles[1] })
    const names = page.locator('.teaching-selected-entries li')
    for (const width of [1400, 560]) {
      await page.setViewportSize({ width, height: 775 })
      const box = await first.boundingBox()
      assert.ok(box && box.width >= 16 && box.height >= 16)
    }
    await page.setViewportSize({ width: 1400, height: 775 })
    await first.locator('..').click()
    assert.ok(await first.isChecked())
    const background = checkbox => checkbox.evaluate(input => getComputedStyle(input.closest('label')).backgroundColor)
    assert.notEqual(await background(first), await background(second))
    await second.check()
    assert.deepEqual(await names.allTextContents(), titles)
    assert.ok(await names.first().isVisible())
    await first.uncheck()
    assert.deepEqual(await names.allTextContents(), [titles[1]])
    await page.getByRole('button', { name: '删除所选（1）' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.ok((await dialog.innerText()).includes(titles[1]))
    assert.ok(!(await dialog.innerText()).includes(titles[0]))
  } finally { await context.close() }
})

test('slow page creation blocks repeated Enter and clicks until the request finishes', async () => {
  const { context, page, errors } = await open()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let calls = 0
  try {
    await page.route((url) => url.pathname === '/api/courses/k1/pages', async (route) => {
      calls++
      await pending
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'new-page', title: '新页面', contentMd: '', sectionTags: {}, sortOrder: 1, syncState: 'SYNCED' } }) })
    })
    await page.locator('.anticon-more').first().click()
    await page.getByRole('menuitem', { name: '新建页面', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input').fill('新页面')
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/courses/k1/pages')
    await dialog.locator('input').press('Enter')
    await requested
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    const create = dialog.getByRole('button', { name: /创\s*建/ })
    assert.equal(await create.isDisabled(), true)
    await create.dispatchEvent('click')
    assert.equal(calls, 1)
    release()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(calls, 1)
    assert.deepEqual(errors, [])
  } finally {
    release()
    await context.close()
  }
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

test('a numbered formula can be authored without a teaching evidence card', async () => {
  const { context, page, errors } = await open()
  let stored
  let creates = 0
  try {
    await page.route('**/api/courses/k1/teaching-cards', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { success: true, data: stored ? [stored] : [] } })
      creates++
      const draft = route.request().postDataJSON()
      assert.equal(draft.approvedPayload.code, 'L1-F01')
      assert.equal(draft.approvedPayload.refObjects[0].value, 'a+b')
      assert.deepEqual(draft.evidence, [])
      stored = { id: 'entry', revision: 1, approved: draft, approvedRevision: 1, draft }
      return route.fulfill({ json: { success: true, data: stored } })
    })
    await page.getByRole('tab', { name: '教学条目' }).click()
    await page.getByRole('button', { name: '新建条目' }).click()
    await page.getByRole('combobox', { name: '条目类型' }).press('ArrowDown')
    await page.getByText('引用对象', { exact: true }).last().click()
    await page.getByRole('textbox', { name: '课程内编号' }).fill('L1-F01')
    await page.getByLabel('英文概念名称').fill('Addition')
    await page.getByLabel('英文摘要').fill('Add the components.')
    const formula = page.getByRole('textbox', { name: '公式', exact: true })
    const hint = page.getByText('只填公式正文。系统会自动在首尾添加 $$，粘贴公式时请去掉这两处标记。', { exact: true })
    await hint.waitFor()
    await formula.fill('a+b')
    assert.ok(await hint.isVisible())
    assert.equal(await formula.getAttribute('aria-describedby'), await hint.getAttribute('id'))
    assert.equal(await page.getByLabel('教材原文摘录').count(), 0)
    await page.getByRole('button', { name: '保存草稿' }).click()
    await page.getByRole('button', { name: /L1-F01/ }).waitFor()
    await page.reload()
    assert.equal(await formula.inputValue(), 'a+b')
    assert.equal(creates, 1)
    assert.equal(await page.getByText('本页暂存', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

for (const [locale, tab, add] of [['zh-CN', '教学条目', '新建条目'], ['en-GB', 'Teaching entries', 'Add entry']]) {
  test(`teaching layout and type width stay stable in ${locale}`, async () => {
    const { context, page } = await open(undefined, [], locale)
    try {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await page.getByRole('button', { name: add }).click()
      const sidebar = page.locator('.teaching-sidebar')
      const editor = page.locator('.teaching-editor')
      const type = editor.locator('.teaching-select-row .ant-select').first()
      const menu = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      const left = await sidebar.boundingBox()
      const right = await editor.boundingBox()
      assert.equal(left.y, right.y)
      assert.ok(left.x + left.width < right.x)
      const initial = await type.boundingBox()
      await type.click()
      await menu.first().waitFor()
      const labels = await menu.allTextContents()
      assert.equal(labels.length, 9)
      for (const label of labels) {
        const option = menu.filter({ hasText: label }).first()
        await option.scrollIntoViewIfNeeded()
        assert.ok(await option.evaluate(el => el.scrollWidth <= el.clientWidth), label)
        await option.click()
        const selected = type.locator('.ant-select-selection-item')
        assert.equal(await selected.innerText(), label)
        assert.ok(await selected.evaluate(el => el.scrollWidth <= el.clientWidth), label)
        const current = await type.boundingBox()
        assert.equal(current.width, initial.width)
        assert.equal(current.x, initial.x)
        await type.click()
      }
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 680, height: 800 })
      const narrowLeft = await sidebar.boundingBox()
      const narrowRight = await editor.boundingBox()
      assert.equal(narrowLeft.x, narrowRight.x)
      assert.ok(narrowLeft.y + narrowLeft.height <= narrowRight.y)
      assert.ok((await type.boundingBox()).width <= narrowRight.width)
    } finally { await context.close() }
  })
}

test('incomplete teaching drafts survive tab, workspace, history, course and reload changes', async () => {
  const { context, page, errors } = await open()
  const tab = name => page.getByRole('tab', { name, exact: true })
  const add = page.getByRole('button', { name: '新建条目' })
  const formula = page.getByRole('textbox', { name: '公式', exact: true })
  const result = data => ({ json: { success: true, data } })
  try {
    await page.route('**/api/courses', route => route.fulfill(result([course, { ...course, id: 'k2', title: '另一门课' }])))
    await page.route('**/api/courses/k2', route => route.fulfill(result({ ...course, id: 'k2', title: '另一门课', pages: [] })))
    await tab('教学条目').click()
    await add.click()
    await page.getByRole('combobox', { name: '条目类型' }).press('ArrowDown')
    await page.getByText('引用对象', { exact: true }).last().click()
    await page.getByRole('textbox', { name: '搜索条目' }).fill('L1')
    await formula.fill('a+b')
    const localUrl = page.url()
    const scroll = page.locator('.teaching-editor-body')
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
    const offset = await scroll.evaluate(el => el.scrollTop)
    assert.ok(offset > 0)
    await tab('知识页面').click()
    await page.locator('.cm-editor').waitFor()
    await page.locator('[data-menu=aiTutor]').click()
    await page.locator('[data-menu=knowledge]').click()
    await tab('教学条目').click()
    await formula.waitFor()
    assert.equal(await formula.inputValue(), 'a+b')
    assert.equal(await scroll.evaluate(el => el.scrollTop), offset)
    assert.equal(await page.getByRole('textbox', { name: '搜索条目' }).inputValue(), 'L1')
    await formula.fill('a+b+c')
    await page.reload()
    assert.equal(await formula.inputValue(), 'a+b+c')
    await page.getByRole('combobox', { name: '课程', exact: true }).press('ArrowDown')
    await page.locator('.ant-select-item-option-content').filter({ hasText: '另一门课' }).click()
    await add.click()
    await page.getByRole('textbox', { name: '学生问题' }).fill('另一条草稿')
    await page.goBack()
    await page.goBack()
    assert.equal(page.url(), localUrl)
    assert.equal(await formula.inputValue(), 'a+b+c')
    await page.locator('[data-menu=aiTutor]').click()
    await page.locator('[data-menu=knowledge]').click()
    assert.equal(await formula.inputValue(), 'a+b+c')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('a changed server revision preserves the local text until the author resolves the conflict', async () => {
  const { context, page } = await open()
  let revision = 1
  let writes = 0
  const draft = { type: 'professor_qa', topic: '*', conceptId: 'qa', canonicalPoint: '',
    bilingual: { conceptLabel: { zh: '', en: '' }, summary: { zh: '', en: '' }, triggers: { zh: [], en: [] } },
    approvedPayload: { question: '向量如何相加？', answerMd: '服务端 ' + revision },
    evidence: [], useWhen: ['*'], doNotUseWhen: [], links: [], priority: 10 }
  try {
    await page.route('**/api/courses/k1/teaching-cards', route => route.fulfill({ json: { success: true, data: [
      { id: 'qa1', revision, approved: null, draft: { ...draft, approvedPayload: { ...draft.approvedPayload, answerMd: '服务端 ' + revision } } },
    ] } }))
    await page.route('**/api/courses/k1/teaching-cards/qa1', route => { writes++; return route.abort() })
    await page.goto(base + '/zh-CN/knowledge?tab=teaching&courseId=k1&entryId=qa1')
    const answer = page.getByRole('textbox', { name: '教授回答' })
    await answer.fill('未提交的修改')
    revision++
    await page.reload()
    assert.equal(await answer.inputValue(), '未提交的修改')
    assert.ok(await page.getByRole('button', { name: '保存草稿' }).isDisabled())
    await page.getByRole('button', { name: '查看最新版本' }).click()
    assert.equal(await answer.inputValue(), '服务端 2')
    await page.getByRole('button', { name: '查看我的修改' }).click()
    assert.equal(await answer.inputValue(), '未提交的修改')
    await page.getByRole('button', { name: '查看最新版本' }).click()
    await page.getByRole('button', { name: '放弃我的修改并采用此版本' }).click()
    await page.reload()
    assert.equal(await answer.inputValue(), '服务端 2')
    assert.equal(writes, 0)
  } finally { await context.close() }
})

test('knowledge page autosaves during editing after five seconds', async () => {
  const { context, page } = await open()
  const writes = []
  try {
    await page.route('**/api/pages/p1', route => {
      if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON())
      return route.fulfill({ json: { success: true, data: {} } })
    })
    await page.locator('.cm-content').press('End')
    const started = Date.now()
    await page.keyboard.insertText('auto-five')
    await page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith('/api/pages/p1'), { timeout: 7000 })
    assert.ok(Date.now() - started >= 4900)
    assert.equal(writes.length, 1)
    assert.match(writes[0].contentMd, /auto-five/)
  } finally { await context.close() }
})

test('sign-out clears teaching drafts and a different employee cannot resume them', async () => {
  const { context, page } = await open(undefined, [], 'en-GB')
  try {
    await page.getByRole('tab', { name: 'Teaching entries' }).click()
    await page.getByRole('button', { name: 'Add entry' }).click()
    const question = page.getByRole('textbox', { name: 'Student question' })
    await question.fill('Private unfinished question')
    const url = page.url()
    await page.reload()
    assert.equal(await question.inputValue(), 'Private unfinished question')
    await page.getByRole('button', { name: 'Employee menu' }).click()
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
    await page.waitForURL('**/sign-in')
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('backoffice.workspace.'))), false)
    await page.route('**/api/session', route => route.fulfill({ json: { success: true, data: {
      employee: { employeeId: 'e2', role: 'ADMIN', loginEmail: 'other@example.com', displayName: 'Other', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED' },
    } } }))
    await page.goto(url)
    assert.equal(await question.inputValue(), '')
  } finally { await context.close() }
})

test('module links return to the selected knowledge page preview', async () => {
  const { context, page } = await open(undefined, [], 'en-GB')
  try {
    const editorPreview = page.getByRole('button', { name: /Preview$/ })
    await editorPreview.click()
    await page.locator('.wmde-markdown').getByText('测试正文').waitFor()
    await page.locator('[data-menu=aiTutor]').click()
    await page.locator('[data-menu=knowledge]').click()
    await page.locator('.wmde-markdown').getByText('测试正文').waitFor()
    assert.equal(new URL(page.url()).searchParams.get('pageId'), 'p1')
    await page.reload()
    await page.locator('.wmde-markdown').getByText('测试正文').waitFor()
  } finally { await context.close() }
})

test('historical previews resolve the same reference using each release caption', async () => {
  const releases = ['L1-F01', 'L1-F02'].map((code, i) => ({
    id: 'r' + i, code, versionTag: '课程版本 ' + (i + 1), createdAt: '2026-11-23T03:00:00Z', isEditing: i === 0,
  }))
  const { context, page, errors } = await open(undefined, releases)
  try {
    await page.route('**/api/releases/*', route => {
      const release = releases.find(row => route.request().url().endsWith('/' + row.id))
      const ref = { id: 'stable', kind: 'latex', value: 'a+b', code: release.code, label: release.code + ' · 加法', requires: [] }
      return route.fulfill({ json: { success: true, data: { ...release, courseId: 'k1', snapshotData: {
        pages: [{ id: 'p1', title: '课文', contentMd: '[原编号](refobj:stable)' }],
        teachingPackage: { cards: [{ approvedPayload: { refObjects: [ref] } }] },
      } } } })
    })
    await page.getByRole('tab', { name: '版本', exact: true }).click()
    await page.getByRole('table').getByText(releases[0].versionTag, { exact: true }).click()
    const history = page.getByRole('dialog', { name: '历史版本' })
    for (const release of releases) {
      await history.getByText(release.versionTag, { exact: true }).locator('..').getByRole('button', { name: /预\s*览/ }).click()
      const preview = page.getByRole('dialog', { name: release.versionTag, exact: true })
      await preview.locator('.katex').waitFor()
      assert.ok((await preview.innerText()).includes(release.code + ' · 加法'))
      await preview.getByRole('button', { name: 'Close', exact: true }).click()
      await preview.waitFor({ state: 'hidden' })
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('release history fits the viewport and scrolls independently of its title', async () => {
  const releases = Array.from({ length: 12 }, (_, index) => ({
    id: `r${index + 1}`,
    versionTag: index === 11 ? 'LongVersionName'.repeat(12) : `课程版本 ${index + 1}`,
    revisionNotes: index === 11 ? `${'LongRevisionNote'.repeat(12)} 末条版本` : `版本备注 ${index + 1}`,
    createdAt: '2026-11-23T03:00:00Z',
    isEditing: index === 0,
    indexStatus: 'ready',
    indexChunkCount: 42,
  }))
  const { context, page } = await open(undefined, releases)
  const versionsTab = page.getByRole('tab', { name: '版本', exact: true })
  const dialog = page.getByRole('dialog', { name: '历史版本' })
  const content = dialog.locator('.ant-modal-content')
  const list = dialog.locator('.ant-modal-body')
  const title = dialog.getByText('历史版本', { exact: true })
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  const openHistory = async () => {
    await versionsTab.click()
    await page.getByRole('table').getByText('课程版本 1', { exact: true }).click()
    await dialog.and(page.locator('.ant-modal:not(.ant-zoom)')).waitFor()
  }

  try {
    await openHistory()
    const desktop = await content.boundingBox()
    assert.equal(desktop.width, 960)
    assert.equal(desktop.height, 820)

    await page.setViewportSize({ width: 360, height: 560 })
    const narrow = await content.boundingBox()
    assert.equal(narrow.width, 328)
    assert.ok(Math.abs(narrow.height - 459.2) < 1)
    assert.ok(narrow.x >= 15 && narrow.y >= 15)
    assert.ok(narrow.x + narrow.width <= 345 && narrow.y + narrow.height <= 545)
    const titleBeforeScroll = await title.boundingBox()
    const lastNote = list.getByText(/末条版本$/)
    await lastNote.scrollIntoViewIfNeeded()
    const scroll = await list.evaluate((element) => ({
      top: element.scrollTop,
      horizontalOverflow: element.scrollWidth - element.clientWidth,
    }))
    assert.ok(scroll.top > 0)
    assert.equal(scroll.horizontalOverflow, 0)
    assert.deepEqual(await title.boundingBox(), titleBeforeScroll)
    await close.click()
    await dialog.waitFor({ state: 'hidden' })

    await page.setViewportSize({ width: 1440, height: 1000 })
    releases.length = 1
    await page.getByRole('tab', { name: '知识页面' }).click()
    await openHistory()
    assert.deepEqual(await content.boundingBox(), desktop)
    assert.equal(await list.evaluate((element) => element.scrollHeight - element.clientHeight), 0)
  } finally { await context.close() }
})
