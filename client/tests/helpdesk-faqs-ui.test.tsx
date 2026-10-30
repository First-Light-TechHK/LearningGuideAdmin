import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { HelpdeskFaq } from '../src/backoffice/contracts/helpdesk'
import { absent, faq, installFakeServer, type Call, type FakeServer } from './support/helpdesk-fake'
import { location, renderHelpDesk, router } from './support/helpdesk-render'

/**
 * Tickets v2 §3a / §3b：FAQs Tab（Figma 1379:2）、新增 / 编辑抽屉（Figma 1379:299）与 Preview，
 * 经 HelpDeskPage 渲染，fetch 换成假的 BackOffice Server。
 */

const LIST = '/api/helpdesk/faqs'
const ONE = /^\/api\/helpdesk\/faqs\/[^/]+$/
const ARCHIVE = /^\/api\/helpdesk\/faqs\/[^/]+\/archive$/

let server: FakeServer
let rows: HelpdeskFaq[]
let total: number | null

function serveFaqs(...items: HelpdeskFaq[]) {
  rows = items
  total = null
  server.on('GET', LIST, (call) => ({
    data: { faqs: rows, total: total ?? rows.length, page: Number(call.query.get('page') ?? 1), pageSize: 10 },
  }))
  // Enquiries Tab 上也能新增 FAQ：工单列表也要能应答
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

async function openFaqs(options: { role?: 'ADMIN' | 'COURSE_CREATOR'; locale?: 'en-GB' | 'zh-CN'; query?: string } = {}) {
  await renderHelpDesk(server, {
    role: options.role,
    path: `/${options.locale ?? 'en-GB'}/help-desk?tab=faqs${options.query ?? ''}`,
  })
  await waitFor(() => assert.ok(server.callsTo('GET', LIST).length >= 1))
}

function drawer(): HTMLElement {
  return screen.getByRole('dialog')
}

function field(label: RegExp | string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return within(drawer()).getByLabelText(label) as HTMLInputElement
}

function fill(label: RegExp | string, value: string) {
  fireEvent.change(field(label), { target: { value } })
}

function fillValidDraft() {
  fireEvent.change(field(/^Category/), { target: { value: 'payments_subscriptions' } })
  fill(/^Question \(English\)/, '  Can I get a refund?  ')
  fill(/^Answer \(English\)/, 'Yes, within **14 days**.')
  fill(/^Question \(Chinese\)/, '可以退款吗？')
  fill(/^Answer \(Chinese\)/, '可以，14 天内。')
  fill('Keywords (for search & AI)', 'Refund, money back')
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('FAQs tab (Figma 1379:2)', () => {
  test('tabs, count, columns and rows: question, first answer line, category chip, popular, date, Edit and Preview', async () => {
    serveFaqs(
      faq('f1', {
        questionEn: 'I did not receive the password reset email',
        answerEn: '1. Check your **spam** folder\n2. Request a new link',
        popular: true,
        updatedAt: '2026-10-28T08:30:00Z',
      }),
      faq('f2', { questionEn: 'Can I get a refund?', category: 'payments_subscriptions', popular: false }),
    )
    await openFaqs()
    const tabs = screen.getAllByRole('tab')
    assert.deepEqual(
      tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
        ['Enquiries', 'false'],
        ['FAQs', 'true'],
        // v5 Part G4 / G6（待视觉验收）
        ['FAQ candidates', 'false'],
        ['HelpDesk data', 'false'],
      ],
    )
    assert.ok(screen.getByRole('button', { name: '+ Add FAQ' }))
    assert.deepEqual(
      screen.getAllByRole('columnheader').map((th) => th.textContent),
      ['Question / Answer', 'Category', 'Popular', 'Last Updated', 'Action'],
    )
    const first = await waitFor(() => tableRow('I did not receive the password reset email'))
    assert.ok(within(first).getByText('Check your spam folder'))
    assert.ok(within(first).getByText('Account & Technical Support'))
    assert.ok(within(first).getByText('Yes'))
    assert.ok(within(first).getByText('28 Oct 2026'))
    assert.ok(within(first).getByRole('button', { name: 'Edit I did not receive the password reset email' }))
    assert.ok(within(first).getByRole('button', { name: 'Preview I did not receive the password reset email' }))
    const second = tableRow('Can I get a refund?')
    assert.ok(within(second).getByText('Payments & Subscriptions'))
    assert.ok(within(second).getByText('No'))
    assert.ok(screen.getByText('2 FAQs'))
    assert.ok(screen.getByText('Showing 1–2 of 2 FAQs'))
    assert.equal(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current'), 'page')
    assert.deepEqual(lastListQuery(), { page: '1', pageSize: '10' })
  })

  test('the legacy ?tab=questions link opens FAQs', async () => {
    serveFaqs(faq('f1'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk?tab=questions' })
    assert.equal(screen.getByRole('tab', { name: 'FAQs' }).getAttribute('aria-selected'), 'true')
    await waitFor(() => assert.ok(server.callsTo('GET', LIST).length >= 1))
  })

  test('switching tabs moves between /help-desk and ?tab=faqs', async () => {
    serveFaqs(faq('f1'))
    await openFaqs()
    fireEvent.click(screen.getByRole('tab', { name: 'Enquiries' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk'))
    fireEvent.click(screen.getByRole('tab', { name: 'FAQs' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?tab=faqs'))
  })

  test('zh-CN: 工单 / 常见问题 tabs, Chinese question and answer, Chinese labels', async () => {
    serveFaqs(faq('f1', { questionZh: '没有收到重置密码邮件', answerZh: '请检查**垃圾邮件**文件夹', popular: true }))
    await openFaqs({ locale: 'zh-CN' })
    assert.deepEqual(
      screen.getAllByRole('tab').map((tab) => tab.textContent),
      ['工单', '常见问题', 'FAQ 候选', 'HelpDesk 数据'],
    )
    assert.ok(screen.getByRole('button', { name: '+ 新增常见问题' }))
    const first = await waitFor(() => tableRow('没有收到重置密码邮件'))
    assert.ok(within(first).getByText('请检查垃圾邮件文件夹'))
    assert.ok(within(first).getByText('账户与技术支持'))
    assert.ok(within(first).getByText('是'))
    assert.ok(within(first).getByRole('button', { name: '编辑 没有收到重置密码邮件' }))
    assert.ok(screen.getByText('1 条常见问题'))
  })

  test('search (debounced), category and popular filters go into the address bar and the request; page resets', async () => {
    serveFaqs(faq('f1'))
    await openFaqs({ query: '&page=2' })
    assert.equal(lastListQuery().page, '2')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search questions, answers or keywords...' }), {
      target: { value: 'reset' },
    })
    await waitFor(() => assert.equal(lastListQuery().q, 'reset'), { timeout: 2000 })
    assert.equal(lastListQuery().page, '1')
    assert.match(location.current, /q=reset/)
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'courses_learning' } })
    await waitFor(() => assert.equal(lastListQuery().category, 'courses_learning'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Popular' }), { target: { value: 'popular' } })
    await waitFor(() => assert.equal(lastListQuery().popular, 'true'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Popular' }), { target: { value: 'not_popular' } })
    await waitFor(() => assert.equal(lastListQuery().popular, 'false'))
    assert.match(location.current, /tab=faqs/)
    assert.match(location.current, /category=courses_learning/)
    assert.match(location.current, /popular=not_popular/)
  })

  test('a filter changed while the search is still debouncing is kept when the search lands', async () => {
    // Found in the cross-app run: clearing the search and picking "Popular" within 300 ms
    // lost the Popular filter, because the debounced write used the address bar of the
    // render in which the search was typed.
    serveFaqs(faq('f1'))
    await openFaqs({ query: '&q=reset' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search questions, answers or keywords...' }), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Popular' }), { target: { value: 'popular' } })
    await waitFor(() => assert.equal(lastListQuery().popular, 'true'))
    // The debounced search write (300 ms) must not undo the Popular filter.
    await new Promise((resolve) => setTimeout(resolve, 450))
    await waitFor(() => assert.equal(lastListQuery().q, undefined))
    assert.equal(lastListQuery().popular, 'true')
    assert.match(location.current, /popular=popular/)
    assert.doesNotMatch(location.current, /q=reset/)
  })

  test('the category filter lists every category with its label', async () => {
    serveFaqs()
    await openFaqs()
    const select = screen.getByRole('combobox', { name: 'Category' })
    assert.deepEqual(
      within(select).getAllByRole('option').map((option) => option.textContent),
      ['All categories', 'Account & Technical Support', 'Courses & Learning', 'Payments & Subscriptions', 'Other Enquiries'],
    )
    const popular = screen.getByRole('combobox', { name: 'Popular' })
    assert.deepEqual(
      within(popular).getAllByRole('option').map((option) => option.textContent),
      ['All FAQs', 'Popular', 'Not popular'],
    )
  })

  test('empty list: unfiltered vs filtered message', async () => {
    serveFaqs()
    await openFaqs()
    assert.ok(await screen.findByText('No FAQs yet.'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'other' } })
    assert.ok(await screen.findByText('No FAQs match your search or filters.'))
  })

  test('paging: 15 FAQs give two pages; Next and page buttons load that page', async () => {
    serveFaqs(...Array.from({ length: 10 }, (_, i) => faq(`f${i}`)))
    total = 15
    await openFaqs()
    assert.ok(await screen.findByText('Showing 1–10 of 15 FAQs'))
    absent(screen.queryByRole('button', { name: 'Previous page' }), 'no Previous on page 1')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => assert.equal(lastListQuery().page, '2'))
    assert.match(location.current, /page=2/)
    assert.ok(await screen.findByText('Showing 11–15 of 15 FAQs'))
    // Figma 1379:2 一页时也画了「›」：最后一页仍显示，但不可点
    assert.equal((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled, true)
    assert.ok(screen.getByRole('button', { name: 'Previous page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Page 1' }))
    await waitFor(() => assert.equal(lastListQuery().page, '1'))
  })

  test('deleting the only row of the last page lands on the new last page, not on an empty one', async () => {
    let all = Array.from({ length: 11 }, (_, i) => faq(`f${i}`, { questionEn: `Question ${i}` }))
    server.on('GET', LIST, (call) => {
      const page = Number(call.query.get('page') ?? 1)
      return { data: { faqs: all.slice((page - 1) * 10, page * 10), total: all.length, page, pageSize: 10 } }
    })
    server.on('POST', ARCHIVE, () => {
      all = all.slice(0, 10)
      return { data: faq('f10', { status: 'archived' }) }
    })
    await openFaqs({ query: '&page=2' })
    assert.ok(await screen.findByText('Showing 11–11 of 11 FAQs'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Question 10' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete FAQ' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    assert.ok(await screen.findByText('Showing 1–10 of 10 FAQs'))
    assert.match(location.current, /page=1|^(?!.*page=)/)
    assert.equal(lastListQuery().page, '1')
    absent(screen.queryByText('No FAQs yet.'))
    assert.equal(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current'), 'page')
  })

  test('a stale ?page= beyond the last page loads the last page', async () => {
    const all = Array.from({ length: 12 }, (_, i) => faq(`f${i}`, { questionEn: `Question ${i}` }))
    server.on('GET', LIST, (call) => {
      const page = Number(call.query.get('page') ?? 1)
      return { data: { faqs: all.slice((page - 1) * 10, page * 10), total: all.length, page, pageSize: 10 } }
    })
    await openFaqs({ query: '&page=99' })
    assert.ok(await screen.findByText('Showing 11–12 of 12 FAQs'))
    assert.match(location.current, /page=2/)
    assert.equal(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current'), 'page')
  })

  test('the search box follows the address bar on Back and Forward', async () => {
    serveFaqs(faq('f1'))
    await openFaqs()
    const box = screen.getByRole('searchbox') as HTMLInputElement
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'other' } })
    await waitFor(() => assert.match(location.current, /category=other/))
    fireEvent.change(box, { target: { value: 'invoice' } })
    await waitFor(() => assert.match(location.current, /q=invoice/))
    router.navigate?.(-1)
    await waitFor(() => assert.doesNotMatch(location.current, /category=other|q=invoice/))
    await waitFor(() => assert.equal(box.value, '', 'Back to before the search empties the box'))
    router.navigate?.(1)
    await waitFor(() => assert.match(location.current, /q=invoice/))
    await waitFor(() => assert.equal(box.value, 'invoice', 'Forward brings the words back'))
  })

  test('a list error is shown', async () => {
    server.on('GET', LIST, { status: 503, error: 'HELPDESK_UNAVAILABLE' })
    await openFaqs()
    assert.equal((await screen.findByRole('alert')).textContent, 'HelpDesk is unavailable right now. Please try again.')
  })
})

describe('VIEW role on FAQs', () => {
  test('no Add FAQ and no Edit, but Preview still works', async () => {
    serveFaqs(faq('f1', { questionEn: 'Read only question' }))
    await openFaqs({ role: 'COURSE_CREATOR' })
    const first = await waitFor(() => tableRow('Read only question'))
    absent(screen.queryByRole('button', { name: /Add FAQ/ }))
    absent(within(first).queryByRole('button', { name: /^Edit/ }))
    fireEvent.click(within(first).getByRole('button', { name: 'Preview Read only question' }))
    assert.ok(await screen.findByRole('dialog', { name: 'Preview FAQ' }))
  })
})

describe('FAQ drawer (Figma 1379:299)', () => {
  test('Add FAQ opens an empty drawer; Save with nothing filled marks every required field and sends nothing', async () => {
    serveFaqs()
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add FAQ' })
    assert.ok(within(dialog).getByText('Changes update the FAQ shown in Help Centre and used by AI Support.'))
    assert.equal((field('Popular FAQ') as HTMLInputElement).checked, false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(within(dialog).getAllByText('Required').length, 5))
    assert.equal(server.callsTo('POST', LIST).length, 0)
    // 点过保存后，改字段即时重新校验
    fill(/^Question \(English\)/, 'How?')
    await waitFor(() => assert.equal(within(dialog).getAllByText('Required').length, 4))
    assert.equal(field(/^Question \(English\)/).getAttribute('aria-invalid'), 'false')
    assert.equal(field(/^Answer \(English\)/).getAttribute('aria-invalid'), 'true')
  })

  test('an unsafe link in an answer is refused before saving', async () => {
    serveFaqs()
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fillValidDraft()
    fill(/^Answer \(English\)/, 'Click [here](javascript:alert(1))')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    const message = 'Links must be a full https://, http:// or mailto: address, without spaces or quotes'
    assert.ok(await within(drawer()).findByText(message))
    // Portal 的渲染器会丢掉带引号的地址，所以保存前同样拦住（预览即学生所见）
    fill(/^Answer \(English\)/, "See [Murphy's law](https://en.wikipedia.org/wiki/Murphy's_law)")
    assert.ok(await within(drawer()).findByText(message))
    assert.equal(server.callsTo('POST', LIST).length, 0)
  })

  test('a valid FAQ is created with an Idempotency-Key; the drawer closes, "FAQ saved." shows and the list reloads', async () => {
    serveFaqs()
    server.on('POST', LIST, (call) => ({ status: 201, data: faq('new', call.body as Partial<HelpdeskFaq>) }))
    await openFaqs()
    const before = server.callsTo('GET', LIST).length
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fillValidDraft()
    fireEvent.click(field('Popular FAQ'))
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('FAQ saved.'))
    const [call] = server.callsTo('POST', LIST)
    assert.match(call.idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    assert.deepEqual(call.body, {
      category: 'payments_subscriptions',
      popular: true,
      questionEn: 'Can I get a refund?',
      answerEn: 'Yes, within **14 days**.',
      questionZh: '可以退款吗？',
      answerZh: '可以，14 天内。',
      keywords: ['refund', 'money back'],
      // v5 question trees: the card type, entry and situations are part of the FAQ
      type: 'answer',
      entry: true,
      signals: [],
    })
    await waitFor(() => absent(screen.queryByRole('dialog')))
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).length, before + 1))
  })

  test('a failed create stays in the drawer; retrying the same content reuses the Idempotency-Key', async () => {
    serveFaqs()
    server.on('POST', LIST, { status: 503, error: 'HELPDESK_UNAVAILABLE' })
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fillValidDraft()
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.equal(
      (await within(drawer()).findByRole('alert')).textContent,
      'HelpDesk is unavailable right now. Please try again.',
    )
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(server.callsTo('POST', LIST).length, 2))
    const [first, second] = server.callsTo('POST', LIST)
    assert.equal(second.idempotencyKey, first.idempotencyKey)
    // 内容变了换新 key（Server 对同 key 不同内容回 422）
    fill(/^Question \(English\)/, 'Another question?')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(server.callsTo('POST', LIST).length, 3))
    assert.notEqual(server.callsTo('POST', LIST)[2].idempotencyKey, first.idempotencyKey)
  })

  test('Add FAQ from the Enquiries tab also confirms with "FAQ saved."', async () => {
    serveFaqs()
    server.on('POST', LIST, (call) => ({ status: 201, data: faq('new', call.body as Partial<HelpdeskFaq>) }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog', { name: 'Add FAQ' })
    fillValidDraft()
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('FAQ saved.'))
  })

  test('Edit loads every field and saves with the version', async () => {
    serveFaqs(
      faq('f1', {
        questionEn: 'How do I reset my password?',
        answerEn: 'Use **Forgot password**.',
        keywords: ['password', 'reset'],
        popular: true,
        version: 4,
      }),
    )
    server.on('PUT', ONE, (call) => ({ data: faq('f1', { ...(call.body as Partial<HelpdeskFaq>), version: 5 }) }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit How do I reset my password?' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit FAQ' })
    assert.equal(field(/^Category/).value, 'account_technical')
    assert.equal((field('Popular FAQ') as HTMLInputElement).checked, true)
    assert.equal(field(/^Question \(English\)/).value, 'How do I reset my password?')
    assert.equal(field(/^Answer \(English\)/).value, 'Use **Forgot password**.')
    assert.equal(field(/^Question \(Chinese\)/).value, '问题 f1？')
    assert.equal(field('Keywords (for search & AI)').value, 'password, reset')
    fill(/^Question \(English\)/, 'How can I reset my password?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('FAQ saved.'))
    const [call] = server.callsTo('PUT', ONE)
    assert.equal(call.path, '/api/helpdesk/faqs/f1')
    assert.deepEqual(call.body, {
      category: 'account_technical',
      popular: true,
      questionEn: 'How can I reset my password?',
      answerEn: 'Use **Forgot password**.',
      questionZh: '问题 f1？',
      answerZh: '答案 f1。',
      keywords: ['password', 'reset'],
      type: 'answer',
      entry: true,
      signals: [],
      version: 4,
    })
  })

  test('VERSION_CONFLICT loads the latest version, keeps the draft, and the retry uses the new version', async () => {
    serveFaqs(faq('f1', { questionEn: 'Original', version: 2 }))
    let puts = 0
    server.on('PUT', ONE, () => {
      puts += 1
      return puts === 1 ? { status: 409, error: 'VERSION_CONFLICT' } : { data: faq('f1', { version: 4 }) }
    })
    server.on('GET', ONE, { data: faq('f1', { questionEn: 'Changed elsewhere', version: 3 }) })
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Original' }))
    await screen.findByRole('dialog')
    fill(/^Question \(English\)/, 'My edit')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(
      await within(drawer()).findByText(
        'Someone else changed this FAQ. The latest version is loaded and your changes are kept. Save again to overwrite it.',
      ),
    )
    assert.equal(field(/^Question \(English\)/).value, 'My edit')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('FAQ saved.'))
    const calls = server.callsTo('PUT', ONE)
    assert.deepEqual(
      calls.map((c) => (c.body as { version: number; questionEn: string }).version),
      [2, 3],
    )
    assert.equal((calls[1].body as { questionEn: string }).questionEn, 'My edit')
  })

  test('FAQ_NOT_FOUND on save closes the drawer and says the FAQ no longer exists', async () => {
    serveFaqs(faq('f1', { questionEn: 'Gone soon' }))
    server.on('PUT', ONE, { status: 404, error: 'FAQ_NOT_FOUND' })
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Gone soon' }))
    await screen.findByRole('dialog')
    fill(/^Question \(English\)/, 'Edited')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('This FAQ no longer exists.'))
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('Delete FAQ asks first, then archives with the version; "FAQ deleted." shows', async () => {
    serveFaqs(faq('f1', { questionEn: 'To delete', version: 6 }))
    server.on('POST', ARCHIVE, { data: faq('f1', { status: 'archived', version: 7 }) })
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit To delete' }))
    await screen.findByRole('dialog')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Delete FAQ' }))
    const confirm = await screen.findByRole('alertdialog')
    assert.ok(within(confirm).getByText(/Delete this FAQ\?/))
    assert.equal(server.callsTo('POST', ARCHIVE).length, 0, 'not before confirming')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    assert.ok(await screen.findByText('FAQ deleted.'))
    const [call] = server.callsTo('POST', ARCHIVE)
    assert.equal(call.path, '/api/helpdesk/faqs/f1/archive')
    assert.deepEqual(call.body, { version: 6 })
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('a delete refused because other questions still use it names those questions', async () => {
    serveFaqs(faq('f1', { questionEn: 'Shared answer', version: 6 }))
    server.on('POST', ARCHIVE, { status: 409, error: 'FAQ_HAS_PARENTS' })
    const parent = (id: string, questionEn: string, questionZh: string, status: 'published' | 'archived' = 'published') => ({
      edge: { id: `e-${id}`, parentId: id, childId: 'f1', kind: 'follow_up', position: 0, labelEn: null, labelZh: null, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' },
      node: { id, key: id, type: 'answer', entry: true, category: 'other', questionEn, questionZh, status },
      label: { en: 'Shared answer', zh: '共享答案' },
    })
    server.on('GET', /\/faqs\/f1\/edges$/, {
      data: {
        children: [],
        parents: [parent('p1', 'Why was my card declined?', '为什么卡被拒？'), parent('p2', 'Old question', '旧问题', 'archived')],
      },
    })
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Shared answer' }))
    await screen.findByRole('dialog')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Delete FAQ' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    const alert = await within(drawer()).findByRole('alert')
    assert.match(alert.textContent ?? '', /still a follow-up or option/)
    await waitFor(() => assert.match(alert.textContent ?? '', /Why was my card declined\?/))
    assert.doesNotMatch(alert.textContent ?? '', /Old question/)
    assert.ok(screen.getByRole('dialog'), 'the drawer stays open')
  })

  test('Keep in the delete confirmation keeps the FAQ; a new FAQ has no Delete', async () => {
    serveFaqs(faq('f1', { questionEn: 'Keep me' }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Keep me' }))
    await screen.findByRole('dialog')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Delete FAQ' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep' }))
    absent(screen.queryByRole('alertdialog'))
    assert.equal(server.callsTo('POST', ARCHIVE).length, 0)
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    absent(within(drawer()).queryByRole('button', { name: 'Delete FAQ' }))
  })

  test('unsaved changes: × and Escape ask before discarding; an untouched drawer closes at once', async () => {
    serveFaqs()
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Close' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))

    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fill(/^Question \(English\)/, 'Half written')
    fireEvent.keyDown(drawer(), { key: 'Escape' })
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }))
    absent(screen.queryByRole('alertdialog'))
    assert.equal(field(/^Question \(English\)/).value, 'Half written')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Close' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('toolbar: B, 1., • and Link insert the Markdown subset; an unsafe link address is refused', async () => {
    serveFaqs()
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    const answer = field(/^Answer \(English\)/) as HTMLTextAreaElement
    fill(/^Answer \(English\)/, 'reset password now')
    answer.setSelectionRange(6, 14)
    const toolbar = within(drawer()).getAllByRole('toolbar', { name: 'Formatting' })[0]
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Bold' }))
    assert.equal(answer.value, 'reset **password** now')

    fill(/^Answer \(English\)/, 'one\ntwo')
    answer.setSelectionRange(0, 7)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Numbered list' }))
    assert.equal(answer.value, '1. one\n2. two')
    fill(/^Answer \(English\)/, 'item')
    answer.setSelectionRange(0, 0)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Bulleted list' }))
    assert.equal(answer.value, '- item')

    fill(/^Answer \(English\)/, 'Open settings')
    answer.setSelectionRange(5, 13)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Link' }))
    const address = within(drawer()).getByRole('textbox', { name: 'Link address' })
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Insert link' }))
    assert.ok(within(drawer()).getByText('Use an address that starts with https://, http:// or mailto:'))
    assert.equal(answer.value, 'Open settings')
    fireEvent.change(address, { target: { value: 'https://a.test/s' } })
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Insert link' }))
    assert.equal(answer.value, 'Open [settings](https://a.test/s)')
    absent(within(drawer()).queryByRole('textbox', { name: 'Link address' }))
  })

  test('zh-CN drawer copy', async () => {
    serveFaqs()
    await openFaqs({ locale: 'zh-CN' })
    fireEvent.click(screen.getByRole('button', { name: '+ 新增常见问题' }))
    const dialog = await screen.findByRole('dialog', { name: '新增常见问题' })
    assert.ok(within(dialog).getByLabelText('热门常见问题'))
    assert.ok(within(dialog).getByRole('button', { name: '保存常见问题' }))
    assert.ok(within(dialog).getByRole('button', { name: '取消' }))
    const category = within(dialog).getByLabelText(/^分类/)
    assert.deepEqual(
      within(category).getAllByRole('option').map((option) => option.textContent),
      ['选择分类', '账户与技术支持', '课程与学习', '付款与订阅', '其他问题'],
    )
  })
})

describe('FAQ Preview', () => {
  test('shows the FAQ as the Help Centre does, with an EN / 中文 switch', async () => {
    serveFaqs(
      faq('f1', {
        questionEn: 'Reset email missing',
        answerEn: '1. Check **spam**\n2. Visit [Forgot password](https://x.test/forgot)',
        questionZh: '没有收到重置邮件',
        answerZh: '请检查**垃圾邮件**',
      }),
    )
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Reset email missing' }))
    const dialog = await screen.findByRole('dialog', { name: 'Preview FAQ' })
    const en = within(dialog).getByRole('radio', { name: 'EN' })
    assert.equal(en.getAttribute('aria-checked'), 'true')
    assert.ok(within(dialog).getByRole('heading', { name: 'Reset email missing' }))
    assert.ok(within(dialog).getByText('Account & Technical Support'))
    assert.equal(within(dialog).getByText('spam').tagName, 'STRONG')
    const link = within(dialog).getByRole('link', { name: 'Forgot password' })
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
    fireEvent.click(within(dialog).getByRole('radio', { name: '中文' }))
    assert.ok(within(dialog).getByRole('heading', { name: '没有收到重置邮件' }))
    assert.equal(within(dialog).getByText('垃圾邮件').tagName, 'STRONG')
    assert.ok(within(dialog).getByText('账户与技术支持'), 'the chip follows the preview language')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('in the zh-CN UI the preview starts in 中文', async () => {
    serveFaqs(faq('f1', { questionZh: '中文问题' }))
    await openFaqs({ locale: 'zh-CN' })
    fireEvent.click(await screen.findByRole('button', { name: '预览 中文问题' }))
    const dialog = await screen.findByRole('dialog', { name: '预览常见问题' })
    assert.equal(within(dialog).getByRole('radio', { name: '中文' }).getAttribute('aria-checked'), 'true')
    assert.ok(within(dialog).getByRole('heading', { name: '中文问题' }))
  })

  test('Escape closes the preview', async () => {
    serveFaqs(faq('f1', { questionEn: 'Esc me' }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Esc me' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })
})

describe('the drawer, preview and confirmations are modal', () => {
  function tab(options: { shiftKey?: boolean } = {}) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', ...options })
  }

  test('while the drawer is open the header, tabs and list behind it are inert; Add FAQ and the tabs cannot replace an edit', async () => {
    serveFaqs(faq('f1', { questionEn: 'Being edited' }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Being edited' }))
    await screen.findByRole('dialog', { name: 'Edit FAQ' })
    fill(/^Answer \(Chinese\)/, '写到一半')
    const add = screen.getByRole('button', { name: '+ Add FAQ' })
    assert.ok(add.closest('[inert]'), 'the header button is inert')
    assert.ok(screen.getByRole('tablist').closest('[inert]'), 'the tabs are inert')
    assert.ok(screen.getByRole('table').closest('[inert]'), 'the list behind is inert')
    assert.ok(drawer().closest('[inert]') === null, 'the drawer itself is not')
    fireEvent.click(add)
    assert.ok(screen.getByRole('dialog', { name: 'Edit FAQ' }), 'still the Edit drawer')
    assert.equal(field(/^Answer \(Chinese\)/).value, '写到一半', 'the draft is kept')
    fireEvent.click(screen.getByRole('tab', { name: 'Enquiries' }))
    assert.match(location.current, /tab=faqs/)
    assert.ok(screen.getByRole('dialog', { name: 'Edit FAQ' }))
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Close' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
    assert.ok(screen.getByRole('tablist').closest('[inert]') === null, 'live again once the drawer is closed')
  })

  test('Tab and Shift+Tab stay inside the drawer, and inside a confirmation while it is open', async () => {
    serveFaqs(faq('f1', { questionEn: 'Trap me' }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Trap me' }))
    await screen.findByRole('dialog')
    const close = within(drawer()).getByRole('button', { name: 'Close' })
    const save = within(drawer()).getByRole('button', { name: 'Save FAQ' })
    save.focus()
    tab()
    assert.ok(document.activeElement === close, 'Tab from Save wraps to the first control')
    tab({ shiftKey: true })
    assert.ok(document.activeElement === save, 'Shift+Tab from the first control wraps to Save')
    save.blur()
    tab()
    assert.ok(document.activeElement === close, 'focus outside comes back in')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Delete FAQ' }))
    const confirm = await screen.findByRole('alertdialog')
    const [keep, remove] = within(confirm).getAllByRole('button')
    await waitFor(() => assert.ok(document.activeElement === keep, 'focus on ' + keep.textContent))
    // jsdom 不做 Tab 的默认移动：只验证两端的回绕
    tab({ shiftKey: true })
    assert.ok(document.activeElement === remove, 'Shift+Tab from Keep wraps to Delete, not to the drawer')
    tab()
    assert.ok(document.activeElement === keep, 'Tab from Delete wraps to Keep: the confirmation keeps focus to itself')
  })

  test('Escape works wherever focus is (even on the page body), but not while an input method is composing', async () => {
    serveFaqs(faq('f1', { questionEn: 'Escape me' }))
    await openFaqs()
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')), 'an untouched drawer closes on Escape from the body')

    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    await screen.findByRole('dialog')
    fill(/^Question \(Chinese\)/, 'mi')
    fireEvent.keyDown(field(/^Question \(Chinese\)/), { key: 'Escape', isComposing: true })
    fireEvent.keyDown(field(/^Question \(Chinese\)/), { key: 'Escape', keyCode: 229 })
    absent(screen.queryByRole('alertdialog'), 'Escape that cancels a pinyin candidate is not a close')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    assert.ok(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('alertdialog'), 'Escape closes the confirmation first'))
    assert.ok(screen.getByRole('dialog'))

    const answer = field(/^Answer \(English\)/) as HTMLTextAreaElement
    fill(/^Answer \(English\)/, 'Open settings')
    answer.setSelectionRange(5, 13)
    const toolbar = within(drawer()).getAllByRole('toolbar', { name: 'Formatting' })[0]
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Link' }))
    const address = within(drawer()).getByRole('textbox', { name: 'Link address' })
    fireEvent.change(address, { target: { value: 'https://a.test/s' } })
    fireEvent.keyDown(address, { key: 'Enter', keyCode: 229 })
    assert.equal(answer.value, 'Open settings', 'Enter that confirms an IME candidate does not insert the link')
    fireEvent.keyDown(address, { key: 'Escape', isComposing: true })
    assert.ok(within(drawer()).getByRole('textbox', { name: 'Link address' }), 'nor does a composing Escape cancel it')
    fireEvent.keyDown(address, { key: 'Enter' })
    await waitFor(() => assert.equal(answer.value, 'Open [settings](https://a.test/s)'))
  })

  test('the preview traps focus, makes the page behind it inert and closes on Escape from anywhere', async () => {
    serveFaqs(faq('f1', { questionEn: 'Preview me' }))
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Preview me' }))
    const dialog = await screen.findByRole('dialog', { name: 'Preview FAQ' })
    assert.ok(screen.getByRole('tablist').closest('[inert]'), 'the page behind the preview is inert')
    const close = within(dialog).getByRole('button', { name: 'Close' })
    assert.ok(document.activeElement === close, 'focus on ' + close.textContent)
    // v5: the question tree's way in sits at the foot of the preview (the table keeps Figma's Edit / Preview), so it
    // is the last control; the browser moves Tab from Close to it, the layer wraps from it
    const tree = within(dialog).getByRole('button', { name: 'View question tree', exact: true })
    assert.ok(close.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING, 'after Close')
    tree.focus()
    tab()
    const english = within(dialog).getByRole('radio', { name: 'EN' })
    assert.ok(document.activeElement === english, 'Tab from the last control wraps to the language switch')
    tab({ shiftKey: true })
    assert.ok(document.activeElement === tree, 'Shift+Tab from the first control wraps to the last')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('a save error or a version conflict takes focus, so it is seen even when the body is scrolled to Keywords', async () => {
    serveFaqs(faq('f1', { questionEn: 'Notice me', version: 2 }))
    let puts = 0
    server.on('PUT', ONE, () => {
      puts += 1
      return puts === 1 ? { status: 503, error: 'HELPDESK_UNAVAILABLE' } : { status: 409, error: 'VERSION_CONFLICT' }
    })
    server.on('GET', ONE, { data: faq('f1', { questionEn: 'Changed elsewhere', version: 3 }) })
    await openFaqs()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Notice me' }))
    await screen.findByRole('dialog')
    fill('Keywords (for search & AI)', 'notice')
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    const alert = await within(drawer()).findByRole('alert')
    await waitFor(() => assert.ok(document.activeElement === alert, 'focus on ' + alert.textContent))
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save FAQ' }))
    const status = await within(drawer()).findByRole('status')
    await waitFor(() => assert.ok(document.activeElement === status, 'focus on ' + status.textContent))
  })
})
