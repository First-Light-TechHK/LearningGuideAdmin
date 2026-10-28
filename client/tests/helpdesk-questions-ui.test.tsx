import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { HelpdeskQuestion } from '../src/backoffice/contracts/helpdesk'
import { absent, installFakeServer, question, type Call, type FakeServer } from './support/helpdesk-fake'
import { renderHelpDesk } from './support/helpdesk-render'

/**
 * Common Questions Tab（QuestionsView）与「+ Add Question」/ 编辑弹窗（QuestionModal），
 * 经 HelpDeskPage 渲染，fetch 换成假的 BackOffice Server。
 */

const LIST = '/api/helpdesk/questions'
const ONE = /^\/api\/helpdesk\/questions\/[^/]+$/

let server: FakeServer
let rows: HelpdeskQuestion[]

function serveQuestions(...items: HelpdeskQuestion[]) {
  rows = items
  server.on('GET', LIST, () => ({ data: { questions: rows } }))
  // 列表接口之外，tickets 也要能应答（Enquiries Tab 上新增问题时用）
  server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
}

function lastListQuery(): Record<string, string> {
  const call = server.callsTo('GET', LIST).at(-1) as Call
  return Object.fromEntries(call.query)
}

function tableRow(text: string): HTMLElement {
  const element = screen.getByText(text).closest('tr')
  assert.ok(element, `row containing ${text}`)
  return element as HTMLElement
}

/** antd Select：按 aria-label 打开下拉，点选项（选项在 portal 里）。 */
async function choose(selectLabel: string, optionText: string) {
  const input = screen.getByRole('combobox', { name: selectLabel })
  const select = input.closest('.ant-select') as HTMLElement
  fireEvent.mouseDown(select.querySelector('.ant-select-selector') as HTMLElement)
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-item-option')).find(
      (node) => node.getAttribute('title') === optionText || node.textContent === optionText,
    )
    assert.ok(found, `option ${optionText}`)
    return found as HTMLElement
  })
  fireEvent.click(option)
}

/** 弹窗里的 antd Select 没有 aria-label，用字段 id。 */
async function chooseById(id: string, optionText: string) {
  const input = document.getElementById(id) as HTMLElement
  const select = input.closest('.ant-select') as HTMLElement
  fireEvent.mouseDown(select.querySelector('.ant-select-selector') as HTMLElement)
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')).find(
      (node) => node.textContent === optionText,
    )
    assert.ok(found, `option ${optionText}`)
    return found as HTMLElement
  })
  fireEvent.click(option)
}

async function openQuestions(options: { role?: 'ADMIN' | 'COURSE_CREATOR'; locale?: 'en-GB' | 'zh-CN' } = {}) {
  await renderHelpDesk(server, { role: options.role, path: `/${options.locale ?? 'en-GB'}/help-desk?tab=questions` })
  await waitFor(() => assert.ok(server.callsTo('GET', LIST).length >= 1))
}

/** antd 的 loading 图标淡出要等 CSS 动画（jsdom 里不结束），所以名字按结尾匹配。 */
function saveButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /Save$/ })
}

function modal(): HTMLElement {
  return screen.getByRole('dialog')
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('Common Questions table', () => {
  test('rows show question, answer, keywords, language, type, status, featured, stats and date', async () => {
    serveQuestions(
      question('q1', {
        question: 'How do I reset my password?',
        answer: 'Use the Forgot password link.',
        keywords: ['password', 'login'],
        featured: true,
        stats: { shown: 12, solved: 9, declined: 3 },
        updatedAt: '2026-10-20T10:00:00Z',
      }),
      question('q2', { question: 'Refund policy?', status: 'draft', category: 'payments_subscriptions' }),
    )
    await openQuestions()
    const first = tableRow('How do I reset my password?')
    assert.ok(within(first).getByText('Use the Forgot password link.'))
    assert.ok(within(first).getByText('password · login'))
    assert.ok(within(first).getByText('English (UK)'))
    assert.ok(within(first).getByText('Technical Support'))
    assert.ok(within(first).getByText('Published'))
    assert.ok(within(first).getByText('Featured'))
    assert.ok(within(first).getByText('12 / 9 / 3'))
    assert.ok(within(first).getByText('20 Oct 2026'))
    const second = tableRow('Refund policy?')
    assert.ok(within(second).getByText('Draft'))
    assert.ok(within(second).getByText('Payments & Subscriptions'))
    // 缺省筛选：当前界面语言、草稿 + 已发布
    assert.deepEqual(lastListQuery(), { locale: 'en-GB' })
  })

  test('filters: language, type, status and debounced search go into the request', async () => {
    serveQuestions(question('q1'))
    await openQuestions()
    await choose('Language', 'All languages')
    await waitFor(() => assert.deepEqual(lastListQuery(), {}))
    await choose('Enquiry Type', 'Course Content')
    await waitFor(() => assert.deepEqual(lastListQuery(), { category: 'course_content' }))
    await choose('Status', 'All, including archived')
    await waitFor(() => assert.deepEqual(lastListQuery(), { category: 'course_content', status: 'all' }))
    const before = server.callsTo('GET', LIST).length
    fireEvent.change(screen.getByPlaceholderText('Search questions'), { target: { value: 'refund' } })
    assert.equal(server.callsTo('GET', LIST).length, before, 'debounced')
    await waitFor(() => assert.deepEqual(lastListQuery(), { category: 'course_content', status: 'all', q: 'refund' }))
  })

  test('empty list: unfiltered vs filtered message', async () => {
    serveQuestions()
    await openQuestions()
    assert.ok(await screen.findByText('No common questions yet.'))
    await choose('Status', 'Archived')
    assert.ok(await screen.findByText('No questions match these filters.'))
  })

  test('HELPDESK_NOT_CONNECTED shows the not-connected message', async () => {
    server.on('GET', LIST, { status: 503, error: 'HELPDESK_NOT_CONNECTED' })
    await openQuestions()
    assert.equal((await screen.findByRole('alert')).textContent, 'HelpDesk is not connected yet.')
  })
})

describe('row actions (FULL)', () => {
  test('actions follow the status: published → Unpublish, draft → Publish, archived → Publish again (no Edit)', async () => {
    serveQuestions(
      question('q1', { question: 'Published one', status: 'published' }),
      question('q2', { question: 'Draft one', status: 'draft' }),
      question('q3', { question: 'Archived one', status: 'archived' }),
    )
    await openQuestions()
    const published = tableRow('Published one')
    assert.ok(within(published).getByRole('button', { name: 'Edit' }))
    assert.ok(within(published).getByRole('button', { name: 'Unpublish' }))
    absent(within(published).queryByRole('button', { name: 'Publish' }))
    assert.ok(within(published).getByRole('button', { name: 'Archive' }))
    const draft = tableRow('Draft one')
    assert.ok(within(draft).getByRole('button', { name: 'Publish' }))
    absent(within(draft).queryByRole('button', { name: 'Unpublish' }))
    const archived = tableRow('Archived one')
    assert.ok(within(archived).getByRole('button', { name: 'Publish again' }))
    absent(within(archived).queryByRole('button', { name: 'Edit' }))
    absent(within(archived).queryByRole('button', { name: 'Archive' }))
  })

  test('Publish sends the row version; success says so and reloads', async () => {
    serveQuestions(question('q2', { question: 'Draft one', status: 'draft', version: 4 }))
    server.on('POST', /\/publish$/, () => ({ data: question('q2', { status: 'published', version: 5 }) }))
    await openQuestions()
    const before = server.callsTo('GET', LIST).length
    fireEvent.click(within(tableRow('Draft one')).getByRole('button', { name: 'Publish' }))
    assert.ok(await screen.findByText('Question published.'))
    const [call] = server.callsTo('POST', /\/publish$/)
    assert.equal(call.path, '/api/helpdesk/questions/q2/publish')
    assert.deepEqual(call.body, { version: 4 })
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).length, before + 1))
  })

  test('VERSION_CONFLICT reloads the list and explains', async () => {
    serveQuestions(question('q1', { question: 'Published one', version: 2 }))
    server.on('POST', /\/unpublish$/, () => {
      rows = [question('q1', { question: 'Published one (edited)', version: 3 })]
      return { status: 409, error: 'VERSION_CONFLICT' }
    })
    await openQuestions()
    fireEvent.click(within(tableRow('Published one')).getByRole('button', { name: 'Unpublish' }))
    assert.ok(await screen.findByText('Someone else changed this question. The list has been reloaded, please try again.'))
    assert.ok(await screen.findByText('Published one (edited)'))
  })

  test('Archive asks first, then archives', async () => {
    serveQuestions(question('q1', { question: 'Published one', version: 2 }))
    server.on('POST', /\/archive$/, () => ({ data: question('q1', { status: 'archived', version: 3 }) }))
    await openQuestions()
    fireEvent.click(within(tableRow('Published one')).getByRole('button', { name: 'Archive' }))
    assert.equal(server.callsTo('POST', /\/archive$/).length, 0, 'not before confirming')
    const confirm = await screen.findByText(/Archive this question\?/)
    const popover = confirm.closest('.ant-popover') as HTMLElement
    fireEvent.click(within(popover).getByRole('button', { name: 'Archive' }))
    assert.ok(await screen.findByText('Question archived.'))
    assert.deepEqual(server.callsTo('POST', /\/archive$/)[0].body, { version: 2 })
  })

  test('reorder: arrows only when one language and no other filters; moving sends the whole order', async () => {
    serveQuestions(question('q1', { question: 'First', version: 1 }), question('q2', { question: 'Second', version: 7 }))
    server.on('POST', '/api/helpdesk/questions/reorder', { data: { questions: [] } })
    await openQuestions()
    absent(screen.queryByText('To change the order, choose one language and clear the other filters.'))
    assert.equal((within(tableRow('First')).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled, true)
    assert.equal((within(tableRow('Second')).getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled, true)
    fireEvent.click(within(tableRow('First')).getByRole('button', { name: 'Move down' }))
    assert.ok(await screen.findByText('Order saved.'))
    assert.deepEqual(server.callsTo('POST', '/api/helpdesk/questions/reorder')[0].body, {
      items: [
        { id: 'q2', version: 7 },
        { id: 'q1', version: 1 },
      ],
    })

    await choose('Language', 'All languages')
    assert.ok(await screen.findByText('To change the order, choose one language and clear the other filters.'))
    absent(screen.queryByRole('button', { name: 'Move down' }))
  })
})

describe('VIEW role on Common Questions', () => {
  test('no Add Question, no Actions column, no row actions, no reorder arrows or hint', async () => {
    serveQuestions(
      question('q1', { question: 'Published one', status: 'published' }),
      question('q2', { question: 'Draft one', status: 'draft' }),
      question('q3', { question: 'Archived one', status: 'archived' }),
    )
    await openQuestions({ role: 'COURSE_CREATOR' })
    await screen.findByText('Published one')
    assert.ok(screen.getByText('Your role can view Help Desk but cannot reply or change anything.'))
    absent(screen.queryByRole('button', { name: /Add Question/ }))
    absent(screen.queryByRole('columnheader', { name: 'Actions' }))
    for (const name of ['Edit', 'Publish', 'Publish again', 'Unpublish', 'Archive', 'Move up', 'Move down']) {
      absent(screen.queryByRole('button', { name }), name)
    }
    absent(screen.queryByText('To change the order, choose one language and clear the other filters.'))
    // 筛选仍可用（只读也能查）
    assert.ok(screen.getByRole('combobox', { name: 'Status' }))
  })
})

describe('QuestionModal (Add Question)', () => {
  test('Save with nothing filled shows Required on type, question and answer and sends nothing', async () => {
    serveQuestions()
    await openQuestions()
    fireEvent.click(screen.getByRole('button', { name: /Add Question/ }))
    const dialog = await screen.findByRole('dialog')
    assert.ok(within(dialog).getByText('Add Question'))
    assert.ok(within(dialog).getByText('Publish now'), 'new questions can be published straight away')
    fireEvent.click(saveButton(dialog))
    await waitFor(() => assert.equal(within(dialog).getAllByText('Required').length, 3))
    assert.equal(server.callsTo('POST', LIST).length, 0)
    // 点过保存后改字段即时重新校验
    fireEvent.change(document.getElementById('hd-q-question') as HTMLElement, { target: { value: 'How?' } })
    await waitFor(() => assert.equal(within(dialog).getAllByText('Required').length, 2))
  })

  test('whitespace-only question and answer are still Required', async () => {
    serveQuestions()
    await openQuestions()
    fireEvent.click(screen.getByRole('button', { name: /Add Question/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(document.getElementById('hd-q-question') as HTMLElement, { target: { value: '   ' } })
    fireEvent.change(document.getElementById('hd-q-answer') as HTMLElement, { target: { value: '\n \n' } })
    fireEvent.click(saveButton(dialog))
    await waitFor(() => assert.equal(within(dialog).getAllByText('Required').length, 3))
    assert.equal(server.callsTo('POST', LIST).length, 0)
  })

  test('a valid draft is created; the modal closes, "Question saved." shows and the list reloads', async () => {
    serveQuestions()
    server.on('POST', LIST, (call) => ({ data: question('new', call.body as Partial<HelpdeskQuestion>) }))
    await openQuestions()
    const before = server.callsTo('GET', LIST).length
    fireEvent.click(screen.getByRole('button', { name: /Add Question/ }))
    const dialog = await screen.findByRole('dialog')
    await chooseById('hd-q-category', 'Payments & Subscriptions')
    fireEvent.change(document.getElementById('hd-q-question') as HTMLElement, { target: { value: '  Can I get a refund?  ' } })
    fireEvent.change(document.getElementById('hd-q-answer') as HTMLElement, { target: { value: 'Yes, within 14 days.' } })
    const publish = within(dialog).getByText('Publish now').closest('label')?.querySelector('button') as HTMLElement
    fireEvent.click(publish)
    fireEvent.click(saveButton(dialog))
    assert.ok(await screen.findByText('Question saved.'))
    assert.deepEqual(server.callsTo('POST', LIST)[0].body, {
      locale: 'en-GB',
      category: 'payments_subscriptions',
      question: 'Can I get a refund?',
      answer: 'Yes, within 14 days.',
      keywords: [],
      featured: false,
      publish: true,
    })
    await waitFor(() => absent(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')))
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).length, before + 1))
  })

  test('Add Question from the Enquiries tab also confirms with "Question saved."', async () => {
    serveQuestions()
    server.on('POST', LIST, (call) => ({ data: question('new', call.body as Partial<HelpdeskQuestion>) }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    fireEvent.click(screen.getByRole('button', { name: /Add Question/ }))
    await screen.findByRole('dialog')
    await chooseById('hd-q-category', 'Other Enquiries')
    fireEvent.change(document.getElementById('hd-q-question') as HTMLElement, { target: { value: 'Q' } })
    fireEvent.change(document.getElementById('hd-q-answer') as HTMLElement, { target: { value: 'A' } })
    fireEvent.click(saveButton(modal()))
    assert.ok(await screen.findByText('Question saved.'))
  })

  test('a create error stays in the modal', async () => {
    serveQuestions()
    server.on('POST', LIST, { status: 400, error: 'INVALID_INPUT' })
    await openQuestions()
    fireEvent.click(screen.getByRole('button', { name: /Add Question/ }))
    const dialog = await screen.findByRole('dialog')
    await chooseById('hd-q-category', 'Other Enquiries')
    fireEvent.change(document.getElementById('hd-q-question') as HTMLElement, { target: { value: 'Q' } })
    fireEvent.change(document.getElementById('hd-q-answer') as HTMLElement, { target: { value: 'A' } })
    fireEvent.click(saveButton(dialog))
    assert.equal(
      (await within(dialog).findByRole('alert')).textContent,
      'Please check what you entered and try again.',
    )
    assert.ok(screen.getByRole('dialog'))
  })
})

describe('QuestionModal (Edit)', () => {
  test('VERSION_CONFLICT fetches the latest version, keeps the draft, and the retry uses the new version', async () => {
    serveQuestions(question('q1', { question: 'Old question', answer: 'Old answer', version: 2, keywords: ['a'] }))
    let puts = 0
    server.on('PUT', ONE, (call) => {
      puts += 1
      if (puts === 1) return { status: 409, error: 'VERSION_CONFLICT' }
      return { data: question('q1', { ...(call.body as Partial<HelpdeskQuestion>), version: 6 }) }
    })
    server.on('GET', ONE, { data: question('q1', { question: 'Changed by someone', answer: 'Theirs', version: 5 }) })
    await openQuestions()
    const listBefore = server.callsTo('GET', LIST).length
    fireEvent.click(within(tableRow('Old question')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    assert.ok(within(dialog).getByText('Edit Question'))
    absent(within(dialog).queryByText('Publish now'), 'editing has no publish switch')
    const answer = document.getElementById('hd-q-answer') as HTMLTextAreaElement
    assert.equal(answer.value, 'Old answer')
    fireEvent.change(answer, { target: { value: 'My new answer' } })
    fireEvent.click(saveButton(dialog))

    assert.equal(
      (await within(dialog).findByRole('alert')).textContent,
      'Someone else changed this question. The list has been reloaded, please try again.',
    )
    assert.equal(server.callsTo('GET', ONE)[0].path, '/api/helpdesk/questions/q1')
    assert.equal((document.getElementById('hd-q-answer') as HTMLTextAreaElement).value, 'My new answer', 'draft kept')
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).length, listBefore + 1, 'list refreshed'))
    assert.deepEqual(server.callsTo('PUT', ONE)[0].body, {
      version: 2,
      locale: 'en-GB',
      category: 'technical_support',
      question: 'Old question',
      answer: 'My new answer',
      keywords: ['a'],
      featured: false,
    })

    fireEvent.click(saveButton(dialog))
    assert.ok(await screen.findByText('Question saved.'))
    assert.equal((server.callsTo('PUT', ONE)[1].body as { version: number }).version, 5)
  })

  test('QUESTION_NOT_FOUND closes the modal and says the question no longer exists', async () => {
    serveQuestions(question('q1', { question: 'Gone soon' }))
    server.on('PUT', ONE, { status: 404, error: 'QUESTION_NOT_FOUND' })
    await openQuestions()
    fireEvent.click(within(tableRow('Gone soon')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(saveButton(dialog))
    assert.ok(await screen.findByText('This question no longer exists.'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('Cancel closes without saving', async () => {
    serveQuestions(question('q1', { question: 'Keep me' }))
    await openQuestions()
    fireEvent.click(within(tableRow('Keep me')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
    assert.equal(server.callsTo('PUT', ONE).length, 0)
  })
})

describe('zh-CN', () => {
  test('tab, columns, Add Question and validation text', async () => {
    serveQuestions(question('q1', { locale: 'zh-CN', question: '怎么重置密码？', status: 'draft' }))
    await openQuestions({ locale: 'zh-CN' })
    assert.equal(screen.getByRole('tab', { name: '常见问题' }).getAttribute('aria-selected'), 'true')
    assert.deepEqual(lastListQuery(), { locale: 'zh-CN' })
    const row = tableRow('怎么重置密码？')
    assert.ok(within(row).getByText('简体中文'))
    assert.ok(within(row).getByText('草稿'))
    assert.ok(within(row).getByRole('button', { name: '发布' }))
    assert.ok(screen.getByRole('columnheader', { name: '操作' }))
    fireEvent.click(screen.getByRole('button', { name: /新增问题/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => assert.equal(within(dialog).getAllByText('必填').length, 3))
  })
})

describe('QuestionModal (Edit) when the question vanished during a conflict', () => {
  test('VERSION_CONFLICT then the latest is gone: closes and says it no longer exists', async () => {
    serveQuestions(question('q1', { question: 'Contested' }))
    server.on('PUT', ONE, { status: 409, error: 'VERSION_CONFLICT' })
    server.on('GET', ONE, { status: 404, error: 'QUESTION_NOT_FOUND' })
    await openQuestions()
    fireEvent.click(within(tableRow('Contested')).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(saveButton(dialog))
    assert.ok(await screen.findByText('This question no longer exists.'))
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })
})
