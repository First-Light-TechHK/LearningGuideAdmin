import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const welcome = 'Welcome! Try $E=mc^2$.'
const question = 'In this course, what exactly is a **state**?'
const stateAnswer = [
  'A **state** is the condition of a system at a given time [1].',
  'For cooling coffee, its temperature is a state variable [2].',
  '',
  'Sources',
  '[1] Modeling Life · State',
  '[2] Lesson 3 · States',
].join('\n')
const courseImage = '/api/files/images/c1/22222222-2222-4222-8222-222222222222.png'
const richAnswer = [
  'Intro:',
  '$$', '\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}', '$$',
  '    中文缩进段落。',
  '- Item $c$',
  '',
  '| Symbol | Meaning |', '| --- | --- |', '| E | Energy |',
  '',
  '![Diagram](' + courseImage + ')',
  '',
  '```text', 'long'.repeat(180), '```',
  '',
  'Sources', '[1] Lesson 3',
].join('\r\n')

const composerSelector = '.ai-test-composer'

function waitForComposerHeight(page, height) {
  return page.waitForFunction(({ selector, height }) => {
    const input = document.querySelector(selector + ' textarea')
    return input && Math.abs(input.getBoundingClientRect().height - height) <= 1
  }, { selector: composerSelector, height })
}

async function assertComposerButton(page) {
  const composer = page.locator(composerSelector)
  const input = await composer.locator('textarea').boundingBox()
  const button = await composer.locator('button').boundingBox()
  assert.ok(input && button)
  assert.deepEqual([button.width, button.height], [112, 32])
  assert.ok(Math.abs(button.x - input.x - input.width - 8) <= 1)
  assert.ok(Math.abs(button.y + button.height - input.y - input.height) <= 1)
  assert.ok(await composer.locator('button').evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
}

async function checkComposerGrowth(page, line) {
  const composer = page.locator(composerSelector)
  const input = composer.locator('textarea')
  const height = () => input.evaluate((element) => element.getBoundingClientRect().height)
  const oneRow = await height()
  const lineHeight = await input.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))
  assert.equal(await composer.locator('button').isDisabled(), true)
  await assertComposerButton(page)

  await input.fill(line)
  assert.equal(await height(), oneRow)
  await input.press('End')
  await input.press('Shift+Enter')
  await input.press('x')
  assert.equal(await input.inputValue(), line + '\nx')
  await waitForComposerHeight(page, oneRow + lineHeight)
  await assertComposerButton(page)

  const fourRows = oneRow + 3 * lineHeight
  await input.fill(Array(80).fill(line).join(' '))
  await waitForComposerHeight(page, fourRows)
  assert.doesNotMatch(await input.inputValue(), /\n/)
  await assertComposerButton(page)

  await input.fill(Array(4).fill(line).join('\n'))
  await waitForComposerHeight(page, fourRows)
  const pasted = Array(8).fill(line).join('\n')
  await page.evaluate((content) => navigator.clipboard.writeText(content), pasted)
  await input.press('ControlOrMeta+A')
  await input.press('ControlOrMeta+V')
  assert.equal(await input.inputValue(), pasted)
  await waitForComposerHeight(page, fourRows)
  assert.ok(await input.evaluate((element) => element.scrollHeight > element.clientHeight))
  await assertComposerButton(page)
  assert.equal(await page.evaluate(() => window.tutorRequests.length), 0)
  return oneRow
}

test('AI Test preserves Portal answer rendering and keeps the composer aligned as it grows', async () => {
  const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ args: ['--disable-gpu', '--renderer-process-limit=1'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    page.setDefaultTimeout(9000)
    await page.addInitScript(() => {
      const fetch = window.fetch
      window.tutorRequests = []
      window.fetch = (url, options) => {
        if (url !== '/api/ai/chat-stream') return fetch(url, options)
        window.tutorRequests.push(JSON.parse(options.body))
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            window.pushTutorFrame = (frame) => {
              controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\n\n'))
              if (frame.done || frame.error) controller.close()
            }
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } }))
      }
    })
    const mode = { systemPrompt: null, templateId: null }
    const config = { courseId: 'c1', releaseId: 'r1', releaseTag: 'Modeling Life', isLive: true, online: true,
      hasApiKey: true, hasLiveRelease: true, model: 'fixture-model', llmProvider: 'openrouter',
      runningSolution: 'grounded-jack', welcomeMsg: welcome, main: mode, lecture: mode, socratic: mode, assessment: mode }
    await page.route(url => url.pathname.startsWith('/api/'), (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === courseImage) return route.fulfill({ contentType: 'image/png', body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XbkAAAAASUVORK5CYII=', 'base64',
      ) })
      const data = path === '/api/session' ? { employee: { employeeId: 'e1', loginEmail: 'test@example.com', role: 'ADMIN',
        displayName: 'Test', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED' } }
        : path === '/api/courses' ? [{ id: 'c1', title: 'Modeling Life', externalId: 'modeling-life', pages: [] }]
          : path === '/api/ai/config/c1' ? config : []
      return route.fulfill({ json: { success: true, data, error: null } })
    })
    const origin = 'http://127.0.0.1:' + server.httpServer.address().port
    await page.goto(origin + '/en-GB/ai-tutor')
    const chat = page.locator('.ai-test-messages')
    const assistant = chat.locator('.tutor-message-row.assistant')
    const user = chat.locator('.tutor-message-row.user')
    const input = page.getByPlaceholder('Ask the tutor a question...')
    const send = page.getByText('Send', { exact: true })
    const push = (frames) => page.evaluate((events) => {
      for (const frame of events) window.pushTutorFrame(frame)
    }, frames)
    const submit = async (content, count) => {
      await input.fill(content)
      await send.click()
      await page.waitForFunction(expected => window.tutorRequests.length === expected, count)
    }

    await assistant.first().locator('.katex').waitFor()
    await checkComposerGrowth(page, 'A state is a snapshot.')
    await submit(question, 1)
    await assertComposerButton(page)
    await push([{ delta: stateAnswer.slice(0, 62) }])
    await assistant.last().getByText('state', { exact: true }).waitFor()
    await push([{ delta: stateAnswer.slice(62) }, { done: true }])
    const state = assistant.last()
    const sources = state.locator('.tutor-answer-sources')
    await sources.waitFor()
    assert.deepEqual(await sources.locator('p').allTextContents(), ['Sources', '[1] Modeling Life · State', '[2] Lesson 3 · States'])
    assert.equal(await user.last().locator('strong').textContent(), 'state')
    assert.ok(await state.locator('time').getAttribute('datetime'))
    assert.deepEqual(await state.locator('.tutor-answer').evaluate((answer) => {
      const p = getComputedStyle(answer.querySelector('p'))
      const strong = getComputedStyle(answer.querySelector('strong'))
      const sources = getComputedStyle(answer.querySelector('.tutor-answer-sources'))
      const bubble = getComputedStyle(answer.parentElement)
      return [p.fontSize, p.lineHeight, p.marginBottom, strong.fontWeight, sources.paddingLeft, sources.borderLeftWidth,
        getComputedStyle(answer).backgroundColor, bubble.backgroundColor, bubble.borderRadius, bubble.color]
    }), ['13px', '18px', '7.8px', '600', '0px', '0px', 'rgba(0, 0, 0, 0)', 'rgb(248, 249, 251)', '12px 12px 12px 3px', 'rgb(82, 97, 126)'])
    await state.getByRole('button', { name: 'Copy' }).click()
    await page.getByText('Copy as Markdown', { exact: true }).click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert.equal(copied.replace(/\r\n/g, '\n'), stateAnswer)

    await submit('Show a state vector $x(t)$.', 2)
    await user.last().locator('.katex').waitFor()
    const split = richAnswer.indexOf('1 & 2')
    await push([{ delta: richAnswer.slice(0, split) }])
    await assistant.last().getByText('Intro:', { exact: true }).waitFor()
    await push([{ delta: richAnswer.slice(split) }, { done: true }])
    const rich = assistant.last()
    await rich.locator('.tutor-answer-sources').waitFor()
    assert.equal(await rich.locator('.katex-display').count(), 1)
    assert.equal(await rich.locator('.katex-error').count(), 0)
    assert.equal(await rich.locator('table tr').count(), 2)
    assert.equal(await rich.locator('img').getAttribute('src'), courseImage)
    assert.equal(await rich.locator('pre').count(), 1)
    await page.setViewportSize({ width: 1050, height: 900 })
    assert.ok(await chat.evaluate((list) => list.scrollWidth <= list.clientWidth + 1))
    assert.ok(await rich.locator('pre').evaluate((block) => block.scrollWidth > block.clientWidth))

    await page.reload()
    await assistant.last().locator('.katex-display').waitFor()
    await submit('Start another example.', 1)
    await push([{ delta: 'Partial **answer**' }])
    await assistant.last().locator('strong').waitFor()
    await page.getByText('Stop', { exact: true }).click()
    await assistant.last().getByRole('status').getByText('Response stopped').waitFor()
    assert.equal(await assistant.last().locator('strong').textContent(), 'answer')

    await submit('Try an interrupted example.', 2)
    await push([{ delta: 'Still readable.' }, { error: 'AI response was interrupted' }])
    await assistant.last().getByRole('status').getByText('Incomplete response').waitFor()
    assert.equal(await assistant.last().locator('.tutor-answer').textContent(), 'Still readable.')

    await page.getByText('New Chat', { exact: true }).click()
    assert.equal(await user.count(), 0)
    assert.equal(await assistant.count(), 1)
    await page.reload()
    await assistant.first().locator('.katex').waitFor()
    assert.equal(await assistant.count(), 1)

    await page.goto(origin + '/zh-CN/ai-tutor')
    await assistant.first().locator('.katex').waitFor()
    const oneRow = await checkComposerGrowth(page, '状态是系统在某一时刻的条件。')
    const chineseInput = page.getByPlaceholder('向导师提问…')
    const chineseQuestion = '什么是状态？\n请举一个例子。'
    await chineseInput.fill(chineseQuestion)
    await chineseInput.dispatchEvent('compositionstart', { data: 'zhuangtai' })
    await chineseInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true })
    await chineseInput.dispatchEvent('compositionend', { data: '状态' })
    await chineseInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
    assert.equal(await chineseInput.inputValue(), chineseQuestion)
    assert.equal(await page.evaluate(() => window.tutorRequests.length), 0)

    await chineseInput.press('Enter')
    await page.getByText('停止生成', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.tutorRequests[0]?.message), chineseQuestion)
    assert.equal(await chineseInput.inputValue(), '')
    await waitForComposerHeight(page, oneRow)
    await assertComposerButton(page)
    await push([{ delta: '状态就是系统在某一时刻的条件。' }, { done: true }])
    await page.getByText('发送', { exact: true }).waitFor()
    await assertComposerButton(page)
  } finally {
    await browser?.close()
    await server.close()
  }
})
