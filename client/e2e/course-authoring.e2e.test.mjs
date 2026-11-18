// 浏览器 E2E（真 Chromium + Vite dev server，API 走真的服务器）：课程创作全流程。
// 锁住：新建课程拿服务器的 Course ID；中英文课程信息保存；两个课时的新增和换位；视频学习点（含填错的时间显示在那一行）；
// 正文两个 H1 保存两次编号不变；两个展品换位、加触发点；推荐阅读（含空行）；没填完点发布看到服务器列出的原因；补全后发布。
// 需要：真服务器（默认 http://127.0.0.1:3013，库里有一个管理员，E2E_EMAIL / E2E_PASSWORD）、本机 chromium（PW_CHROMIUM）、ffmpeg。
// 运行：E2E_API=http://127.0.0.1:3013 node --test e2e/course-authoring.e2e.test.mjs
// 截图：E2E_SHOTS=<目录> 时保存（2 倍像素）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const API = process.env.E2E_API || 'http://127.0.0.1:3013'
const EMAIL = process.env.E2E_EMAIL || 'align@example.com'
const PASSWORD = process.env.E2E_PASSWORD || 'align-password-123'
const SHOTS = process.env.E2E_SHOTS || null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let server
let browser
let context
let page
let base
const work = mkdtempSync(join(tmpdir(), 'course-e2e-'))

function makeMedia() {
  const png = (name, color) => {
    const file = join(work, name)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=800x370`, '-frames:v', '1', file])
    return file
  }
  const video = join(work, 'lesson.mp4')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
  const square = join(work, 'square.png')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=600x600', '-frames:v', '1', square])
  return { thumb: square, cover: png('cover.png', 'red'), ex1: png('first.png', 'green'), ex2: png('second.png', 'orange'), video }
}

before(async () => {
  server = await createServer({
    root,
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: API, changeOrigin: true } } },
  })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  const executablePath = process.env.PW_CHROMIUM || undefined
  browser = await chromium.launch(executablePath ? { executablePath, args: ['--headless=new', '--no-sandbox'] } : {})
  context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2 })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  // Adding a lesson asks for its title in a browser prompt.
  page.on('dialog', (dialog) => void (dialog.type() === 'prompt' ? dialog.accept(promptAnswer) : dialog.accept()))
})

let promptAnswer = 'Lesson'

after(async () => {
  await browser?.close()
  await server?.close()
})

async function shot(name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

async function courseNow(courseId) {
  const response = await context.request.get(`${base}/api/backoffice/courses/${courseId}`)
  return (await response.json()).data
}

async function settle() {
  await page.waitForLoadState('networkidle')
}

async function openTab(label) {
  await page.getByRole('button', { name: label }).first().click()
  await settle()
}

async function fillLessonInfo(titleEn, descEn, titleZh, descZh) {
  await page.getByTestId('lesson-title-en').fill(titleEn)
  await page.getByTestId('lesson-desc-en').fill(descEn)
  await page.getByTestId('lesson-title-zh').fill(titleZh)
  await page.getByTestId('lesson-desc-zh').fill(descZh)
}

async function save() {
  await page.getByRole('button', { name: 'Save', exact: true }).last().click()
  // A save is several requests followed by a reload; wait until the page is quiet before touching it again.
  await page.waitForTimeout(400)
  await settle()
  await page.waitForTimeout(400)
}

async function setEditorHtml(html) {
  await page.locator('[contenteditable]').first().evaluate((element, value) => {
    element.innerHTML = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, html)
}

test('author a course end to end against the real server', async () => {
  const media = makeMedia()

  // 1. Sign in.
  await page.goto(`${base}/en-GB/sign-in`)
  await page.locator('#sign-in-email').fill(EMAIL)
  await page.locator('#sign-in-password').fill(PASSWORD)
  await page.locator('form button[type=submit]').click()
  await page.waitForURL(/\/en-GB\/course/)
  await settle()

  // 2. Create a course: the Course ID comes from the server and cannot be typed.
  await page.getByRole('button', { name: 'Create course' }).first().click()
  const idInput = page.getByTestId('create-course-id')
  await idInput.waitFor()
  await page.waitForFunction(() => /^[A-Z]+-?\d+/i.test(document.querySelector('[data-testid="create-course-id"]')?.value ?? ''))
  const shownCode = await idInput.inputValue()
  assert.equal(await idInput.getAttribute('readonly'), '')
  await page.locator('input[name=titleEn]').fill('Align Course')
  await page.locator('input[name=titleZh]').fill('对齐课程')
  await page.locator('dialog, [role=dialog]').locator('select').nth(1).selectOption({ index: 1 })
  await page.locator('input[type=checkbox]').first().evaluate((box) => { if (!box.checked) box.click() })
  await page.locator('input[type=checkbox]').nth(1).evaluate((box) => { if (!box.checked) box.click() })
  await shot('create-dialog')
  await page.getByRole('button', { name: 'Create and edit' }).click()
  await page.waitForURL(/\/course\/[0-9a-f-]{36}/)
  await settle()
  const courseId = page.url().match(/course\/([0-9a-f-]{36})/)[1]
  assert.equal(await page.getByTestId('info-course-id').inputValue(), shownCode, 'the editor shows the code the dialog promised')

  // 3. Course Information in English and Chinese, with the server telling us what is missing.
  // The cover goes first: an upload reloads the course, and the form shows what was last saved.
  await page.locator('input[type=file]').first().setInputFiles(media.cover)
  await page.waitForTimeout(800)
  await settle()
  await page.getByTestId('info-title-en').fill('Align Course')
  await page.getByTestId('info-desc-en').fill('A short description for the align course.')
  await page.getByTestId('info-overview-en').fill('An overview long enough to read as an overview of the course.')
  await page.getByTestId('info-title-zh').fill('对齐课程')
  await page.getByTestId('info-desc-zh').fill('对齐课程的简短介绍。')
  await page.getByTestId('info-overview-zh').fill('这是一段足够长的课程概览，用来说明课程内容。')
  for (const [index, word] of ['first', 'second', 'third', 'fourth'].entries()) {
    await page.getByRole('button', { name: 'Add item' }).first().click()
    await page.getByTestId(`learn-en-${index}`).fill(`Learn the ${word} thing`)
    await page.getByTestId(`learn-zh-${index}`).fill(`学会第${index + 1}件事`)
  }
  // "This course provides" rows used to make the whole save fail with 400 (objects were sent where strings are expected).
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole('button', { name: 'Add item' }).nth(1).click()
    await page.locator('div[style*="position: absolute"] button:not([disabled])').first().click()
  }
  await shot('course-information')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await settle()
  let course = await courseNow(courseId)
  assert.equal(course.localizations.find((item) => item.language === 'zh-CN').title, '对齐课程')
  assert.equal(course.localizations.find((item) => item.language === 'en-GB').title, 'Align Course')

  // 4. Lessons: add two, the Lesson ID is read-only, reorder.
  await openTab(/Course Content/)
  promptAnswer = 'First lesson'
  await page.getByRole('button', { name: /Add$/ }).first().click()
  await page.getByRole('button', { name: /^1\./ }).waitFor()
  promptAnswer = 'Second lesson'
  await page.getByRole('button', { name: /Add$/ }).first().click()
  await page.getByRole('button', { name: /^2\./ }).waitFor()
  await settle()
  course = await courseNow(courseId)
  const banner = await page.getByTestId('course-failure').allInnerTexts()
  assert.equal(course.lessons.length, 2, `two lessons; page says ${JSON.stringify(banner)}`)
  const [firstCode, secondCode] = course.lessons.map((lesson) => lesson.code)
  assert.equal(await page.getByTestId('lesson-id').getAttribute('readonly'), '')
  await page.getByRole('button', { name: /^1\./ }).click()
  await fillLessonInfo('First lesson', 'About the first lesson.', '第一课', '关于第一课。')
  await save()
  await page.getByRole('button', { name: /^2\./ }).click()
  await fillLessonInfo('Second lesson', 'About the second lesson.', '第二课', '关于第二课。')
  await save()
  await page.getByRole('button', { name: '↑' }).first().click()
  await settle()
  course = await courseNow(courseId)
  assert.deepEqual([...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((lesson) => lesson.code), [secondCode, firstCode])
  await shot('lessons-reordered')

  // Work in the lesson that is now first (the former second).
  await page.getByRole('button', { name: /^1\./ }).click()
  await settle()
  await page.getByRole('button', { name: /^1\./ }).click()

  // 5. Exhibits: upload two, move one down.
  await page.locator('label', { hasText: 'Upload exhibits' }).locator('input[type=file]').setInputFiles([media.ex1, media.ex2])
  await page.getByTestId('exhibit-row').nth(1).waitFor({ timeout: 30000 })
  await settle()
  const codesBefore = await page.getByTestId('exhibit-row').evaluateAll((rows) => rows.map((row) => row.dataset.exhibitCode))
  assert.equal(codesBefore.length, 2)
  await page.getByTestId('exhibit-down').first().click()
  await page.waitForFunction(
    (first) => document.querySelectorAll('[data-testid="exhibit-row"]').length === 2 && document.querySelector('[data-testid="exhibit-row"]').dataset.exhibitCode !== first,
    codesBefore[0],
  )
  const codesAfter = await page.getByTestId('exhibit-row').evaluateAll((rows) => rows.map((row) => row.dataset.exhibitCode))
  assert.deepEqual(codesAfter, [...codesBefore].reverse(), 'order comes back from the server')
  await shot('exhibits-reordered')

  // 6. Video: upload, add learning points including a bad time and a time past the end.
  await page.locator('label', { hasText: /Replace video|Upload video|video/i }).locator('input[type=file]').first().setInputFiles(media.video).catch(() => {})
  await page.getByText(/Video uploaded|Upload complete/).first().waitFor({ timeout: 60000 })
  await settle()
  await page.getByTestId('add-point').click()
  await page.getByTestId('point-title').nth(0).fill('Point one')
  await page.getByTestId('point-time').nth(0).fill('0:01')
  await page.getByTestId('add-point').click()
  await page.getByTestId('point-title').nth(1).fill('Point two')
  await page.getByTestId('point-time').nth(1).fill('soon')
  // Trigger: pick the first exhibit at 0:02.
  await page.getByRole('button', { name: /Add trigger/ }).click()
  await page.getByTestId('trigger-row').first().locator('select').selectOption({ index: 1 })
  await page.getByTestId('trigger-time').first().fill('0:02')
  await save()
  const rowIssue = page.getByTestId('point-row').nth(1).getByTestId('field-issue')
  await rowIssue.waitFor()
  assert.match(await rowIssue.innerText(), /Row 2/, 'the error names row 2')
  assert.equal(await page.getByTestId('point-time').nth(1).inputValue(), 'soon', 'what was typed is kept')
  assert.equal(await page.getByTestId('point-time').nth(0).inputValue(), '0:01', 'the good row is kept')
  await shot('bad-time-on-row')
  await page.getByTestId('point-time').nth(1).fill('0:02')
  await save()
  assert.equal(await page.getByTestId('point-row').nth(1).getByTestId('field-issue').count(), 0, 'the row 2 error is gone after the fix')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="point-row"]').length === 2)
  await page.waitForTimeout(500)
  course = await courseNow(courseId)
  const lesson = [...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder)[0]
  const videoPoints = lesson.learningPoints.filter((point) => point.source === 'VIDEO' && point.language === 'en-GB')
  assert.deepEqual(videoPoints.map((point) => point.code).sort(), ['V1', 'V2'], `${JSON.stringify(lesson.learningPoints)} ${JSON.stringify(await page.getByTestId('course-failure').allInnerTexts())} ${JSON.stringify(await page.getByTestId('field-issue').allInnerTexts())}`)
  assert.equal(lesson.triggers.length, 1)

  // 7. Text: two H1, save twice, the codes stay.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await setEditorHtml('<h1>Alpha</h1><p>First body.</p><h1>Beta</h1><p>Second body.</p>')
  await save()
  await page.waitForFunction(() => {
    const codes = [...document.querySelectorAll('[data-testid="text-point-code"]')].map((node) => node.textContent.trim())
    return codes.length === 2 && codes.every((code) => /^T\d+$/.test(code))
  })
  const codes1 = await page.getByTestId('text-point-code').allInnerTexts()
  assert.equal(codes1.length, 2)
  assert.ok(codes1.every((code) => /^T\d+$/.test(code.trim())), `stamped codes, got ${codes1}; server text ${JSON.stringify((await courseNow(courseId)).lessons.map((item) => item.localizations.map((loc) => [loc.language, loc.textHtml])))}`)
  await page.locator('[contenteditable]').first().waitFor()
  const stampedHtml = await page.locator('[contenteditable]').first().evaluate((element) => element.innerHTML)
  assert.match(stampedHtml, /data-lp="T\d+"/, 'the editor holds the server-stamped codes')
  await setEditorHtml(stampedHtml.replace('Alpha', 'Alpha renamed'))
  await save()
  await page
    .waitForFunction(() => document.querySelector('[data-testid="text-point"]')?.textContent.includes('Alpha renamed'))
    .catch(async (error) => {
      throw new Error(`${error.message}; points ${JSON.stringify(await page.getByTestId('text-point').allInnerTexts())}; banner ${JSON.stringify(await page.getByTestId('course-failure').allInnerTexts())}; editor ${await page.locator('[contenteditable]').first().innerHTML()}`)
    })
  await page.waitForTimeout(800)
  const codes2 = await page.getByTestId('text-point-code').allInnerTexts()
  assert.deepEqual(codes2, codes1, 'saving again keeps the same codes')
  await shot('text-learning-points')

  // 8. Readings: one filled row and one blank row.
  await page.getByTestId('add-reading').click()
  await page.getByTestId('reading-title').nth(0).fill('A Good Book')
  await page.getByTestId('add-reading').click()
  await save()
  await page.waitForTimeout(800)
  const readingRows = await page.getByTestId('reading-row').count()
  assert.equal(readingRows, 2, 'the blank row stays on the page')
  const serverIssues = ((await courseNow(courseId)).completeness.issues ?? []).filter((issue) => issue.field.startsWith('readings'))
  assert.ok((await page.getByTestId('reading-row').nth(1).getByTestId('field-issue').count()) > 0, `the blank row says what is missing; server says ${JSON.stringify(serverIssues)}`)
  assert.equal(await page.getByTestId('readings-template').getAttribute('href'), `/api/backoffice/courses/${courseId}/readings/template`)
  await shot('readings-blank-row')

  // 9. Publish while incomplete: the server's blockers are listed.
  await openTab(/Versions/)
  await page.getByTestId('publish-open').click()
  // The blockers are listed as soon as the dialog opens, from the course detail, and it does not say the course can still be published.
  await page.getByTestId('publish-blocked').waitFor()
  assert.equal(await page.getByText('You can still publish.').count(), 0)
  assert.doesNotMatch(await page.getByTestId('publish-blocked').innerText(), /[0-9a-f]{8}-[0-9a-f]{4}-/, 'no database ids in the dialog')
  await page.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await page.getByTestId('publish-blocked').waitFor()
  assert.ok((await page.getByTestId('publish-blocker').count()) + (await page.getByTestId('publish-blocked-lesson').count()) > 0)
  await shot('publish-blocked')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // 10. Complete what the server asked for, then publish.
  await openTab(/Course Content/)
  await page.getByRole('button', { name: /^1\./ }).click()
  // Both exhibits: a square thumbnail and a title and description in each language.
  for (const index of [0, 1]) {
    await page.getByTestId('exhibit-row').nth(index).getByRole('button').last().click()
    const drawer = page.locator('.modal')
    await drawer.locator('input[type=file][accept="image/*"]').setInputFiles(media.thumb)
    await drawer.getByText('No thumbnail').waitFor({ state: 'detached', timeout: 30000 })
    const fields = drawer.locator('input:not([type=file])')
    await fields.nth(1).fill(`Exhibit ${index + 1}`)
    await fields.nth(2).fill(`About exhibit ${index + 1}`)
    await fields.nth(3).fill(`展品${index + 1}`)
    await fields.nth(4).fill(`关于展品${index + 1}`)
    await drawer.getByRole('button', { name: 'Save exhibit' }).click()
    await drawer.waitFor({ state: 'detached' })
    await page.waitForTimeout(500)
  }
  // Readings: finish the two rows.
  await page.getByTestId('reading-row').nth(0).locator('input').nth(1).fill('Ann Author')
  await page.getByTestId('reading-row').nth(0).locator('input').nth(2).fill('It is the best start.')
  await page.getByTestId('reading-title').nth(1).fill('A Good Paper')
  await page.getByTestId('reading-row').nth(1).locator('input').nth(1).fill('Bob Author')
  await page.getByTestId('reading-row').nth(1).locator('input').nth(2).fill('It goes deeper.')
  await save()

  const studyIn = async (language) => {
    await page.locator('select:has(option[value="zh-CN"])').first().selectOption(language)
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Video', exact: true }).click()
    if ((await page.getByText('Video uploaded').count()) === 0) {
      await page.locator('input[type=file][accept^="video"]').first().setInputFiles(media.video)
      await page.getByText('Video uploaded').first().waitFor({ timeout: 60000 })
      await settle()
    }
    if ((await page.getByTestId('point-row').count()) === 0) {
      await page.getByTestId('add-point').click()
      await page.getByTestId('point-title').nth(0).fill(`Point in ${language}`)
      await page.getByTestId('point-time').nth(0).fill('0:01')
    }
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    if ((await page.getByTestId('text-point').count()) === 0) await setEditorHtml(`<h1>Heading ${language}</h1><p>Body in ${language}.</p>`)
    await save()
  }
  await studyIn('zh-CN')
  await page.locator('select:has(option[value="zh-CN"])').first().selectOption('en-GB')

  // The second lesson: readings, then video, one learning point and text in both languages.
  await page.getByRole('button', { name: /^2\./ }).click()
  await studyIn('en-GB')
  await studyIn('zh-CN')
  await page.locator('select:has(option[value="zh-CN"])').first().selectOption('en-GB')
  // Uploading a video reloads the course, so typed-but-unsaved rows are added last.
  await page.getByTestId('add-reading').click()
  await page.getByTestId('reading-title').nth(0).fill('Another Book')
  await page.getByTestId('reading-row').nth(0).locator('input').nth(1).fill('Cy Author')
  await page.getByTestId('reading-row').nth(0).locator('input').nth(2).fill('A different view.')
  await save()
  await page.locator('select:has(option[value="zh-CN"])').first().selectOption('en-GB')

  course = await courseNow(courseId)
  const left = (course.completeness.issues ?? []).map((issue) => `${issue.step}:${(issue.lessonId ?? '').slice(0, 4)}:${issue.language ?? '-'}:${issue.field}`)
  assert.deepEqual(left, [], 'nothing is left for the server to ask for')

  await openTab(/Versions/)
  await page.getByTestId('publish-open').click()
  await page.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await page.getByText('Published successfully.').waitFor()
  await shot('published')
  const versions = await (await context.request.get(`${base}/api/backoffice/courses/${courseId}/versions`)).json()
  assert.ok(versions.data.some((version) => version.isLive), 'a live version exists after publishing')
})
