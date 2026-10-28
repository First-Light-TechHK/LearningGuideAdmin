import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { EnquiryDetail } from '../src/backoffice/contracts/helpdesk'
import { absent, deferred, detail, installFakeServer, row, type Call, type FakeServer, type Reply } from './support/helpdesk-fake'
import { location, renderHelpDesk } from './support/helpdesk-render'

/**
 * Enquiries 三栏（HelpDeskPage → EnquiriesView → EnquiryList / EnquiryTimeline / StudentPanel），
 * 走真实路由、真实 RBAC、真实 helpdeskApi，只把 fetch 换成假的 BackOffice Server。
 * 中栏是选中工单的学员时间线（Tickets v2 §3d，Figma 1324:2）：每张卡片一条操作栏，卡片后是 AI 块。
 */

const LIST = '/api/helpdesk/tickets'
const DETAIL = /^\/api\/helpdesk\/tickets\/[^/]+$/
const ACTIONS = /^\/api\/helpdesk\/tickets\/[^/]+\/actions$/
const MESSAGES = /^\/api\/helpdesk\/tickets\/[^/]+\/messages$/

let server: FakeServer
let tickets: Map<string, EnquiryDetail>

function ticketIdOf(call: Call): string {
  return call.path.split('/')[4]
}

/** 列表 + 详情从同一份内存数据应答（时间线请求按 learnerId 过滤，与 Portal 一致）。 */
function serve(...items: EnquiryDetail[]) {
  tickets = new Map(items.map((item) => [item.id, item]))
  server.on('GET', LIST, (call) => {
    const learnerId = call.query.get('learnerId')
    const all = [...tickets.values()]
    return {
      data: {
        tickets: learnerId ? all.filter((item) => item.learner.id === learnerId) : all,
        nextCursor: null,
        counts: {},
      },
    }
  })
  server.on('GET', DETAIL, (call) => {
    const found = tickets.get(ticketIdOf(call))
    return found ? { data: found } : { status: 404, error: 'TICKET_NOT_FOUND' }
  })
}

/** 写操作成功：更新内存里的工单并返回。 */
function respondWith(patch: Partial<EnquiryDetail>): (call: Call) => Reply {
  return (call) => {
    const id = ticketIdOf(call)
    const current = tickets.get(id) as EnquiryDetail
    const next = { ...current, ...patch, sequence: current.sequence + 1 }
    tickets.set(id, next)
    return { data: next }
  }
}

function conversation(): HTMLElement {
  const element = document.querySelector('.hdConversation')
  assert.ok(element, 'conversation panel')
  return element as HTMLElement
}

/** 中栏里某个工单的卡片（article，名字是主题）。 */
async function card(subject: string): Promise<HTMLElement> {
  return waitFor(() => within(conversation()).getByRole('article', { name: subject }))
}

/** 卡片所在的时间线条目（卡片 + 面板 + AI 块 + 对话）。 */
function item(cardElement: HTMLElement): HTMLElement {
  const element = cardElement.closest('.hdTimelineItem')
  assert.ok(element, 'timeline item')
  return element as HTMLElement
}

/** 打开某张卡片的「Email student」回复框。 */
async function openReply(subject = 'Subject a'): Promise<HTMLTextAreaElement> {
  fireEvent.click(within(await card(subject)).getByRole('button', { name: 'Email student' }))
  return (await screen.findByRole('textbox', { name: 'Reply to learner' })) as HTMLTextAreaElement
}

/** 同一个学员的工单（时间线里会一起出现）。 */
function sameLearner(id: string, patch: Partial<EnquiryDetail> = {}): EnquiryDetail {
  const base = detail(id, patch)
  return {
    ...base,
    learner: { id: 'user-l', email: 'l@example.com', name: 'Lena Learner' },
    student: base.student ? { ...base.student, id: 'user-l', name: 'Lena Learner' } : null,
    ...patch,
  }
}

/** 左栏的一行（等列表加载出来）。 */
async function listRow(text: string): Promise<HTMLElement> {
  const label = await waitFor(() => within(document.querySelector('.hdList') as HTMLElement).getByText(text))
  const element = label.closest('button')
  assert.ok(element)
  return element
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('list and URL filters', () => {
  test('filters in the URL are sent to the list request, including a literal "all" search', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk?status=needs_reply&category=other&tag=vip&q=all' })
    await screen.findByText('Subject a')
    const [call] = server.callsTo('GET', LIST)
    assert.deepEqual(Object.fromEntries(call.query), {
      status: 'needs_reply',
      category: 'other',
      tag: 'vip',
      q: 'all',
      limit: '30',
    })
    assert.equal((screen.getByRole('searchbox') as HTMLInputElement).value, 'all')
  })

  test('typing "all" in search is a real search: written to the URL and sent as q=all after the debounce', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    await screen.findByText('Subject a')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'all' } })
    assert.equal(server.callsTo('GET', LIST).length, 1, 'debounced, not sent on every keystroke')
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?q=all'))
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).at(-1)?.query.get('q'), 'all'))
  })

  test('choosing status "All" removes status from the URL and the request; other filters stay', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk?status=OPEN&tag=vip' })
    await screen.findByText('Subject a')
    fireEvent.click(screen.getByRole('button', { name: /Filter enquiries/ }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?tag=vip'))
    await waitFor(() => {
      const last = server.callsTo('GET', LIST).at(-1) as Call
      assert.equal(last.query.has('status'), false)
      assert.equal(last.query.get('tag'), 'vip')
    })
  })

  test('selecting an enquiry keeps the filters in the URL and opens it', async () => {
    serve(detail('a'), detail('b', { subject: 'Second enquiry' }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk?status=ASSIGNED' })
    assert.ok(await screen.findByText('Select an enquiry to see the conversation.'))
    fireEvent.click(await listRow('Second enquiry'))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk/b?status=ASSIGNED'))
    assert.ok(await screen.findByRole('article', { name: 'Second enquiry' }))
    assert.equal((await listRow('Second enquiry')).getAttribute('aria-current'), 'true')
  })

  test('HELPDESK_NOT_CONNECTED (503) shows "HelpDesk is not connected yet"', async () => {
    server.on('GET', LIST, { status: 503, error: 'HELPDESK_NOT_CONNECTED' })
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    assert.ok(await screen.findByRole('heading', { name: 'HelpDesk is not connected yet' }))
    assert.ok(screen.getByText(/The Portal HelpDesk integration is not configured/))
    absent(document.querySelector('.hdList'))
  })

  test('HELPDESK_NOT_CONNECTED on the detail request shows the same state; zh-CN text', async () => {
    server.on('GET', LIST, { data: { tickets: [], nextCursor: null, counts: {} } })
    server.on('GET', DETAIL, { status: 503, error: 'HELPDESK_NOT_CONNECTED' })
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/a' })
    assert.ok(await screen.findByRole('heading', { name: 'HelpDesk 尚未接通' }))
  })

  test('a missing enquiry says it is not available and Try again re-requests it', async () => {
    serve()
    await renderHelpDesk(server, { path: '/en-GB/help-desk/missing' })
    assert.ok(await screen.findByText('This enquiry does not exist or is no longer available.'))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => assert.equal(server.callsTo('GET', DETAIL).length, 2))
  })
})

describe('opening an enquiry', () => {
  test('an unread enquiry is marked read with the sequence the agent saw', async () => {
    serve(detail('a', { unreadByAgent: true, sequence: 7 }))
    server.on('POST', ACTIONS, respondWith({ unreadByAgent: false }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    await screen.findByRole('img', { name: 'Unread' })
    fireEvent.click(await listRow('Subject a'))
    await waitFor(() => assert.equal(server.callsTo('POST', ACTIONS).length, 1))
    const [call] = server.callsTo('POST', ACTIONS)
    assert.equal(call.path, '/api/helpdesk/tickets/a/actions')
    assert.deepEqual(call.body, { action: 'mark_read', expectedSequence: 7 })
    assert.match(call.idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    // 左栏那一行的未读点随之消失
    await waitFor(() => absent(screen.queryByRole('img', { name: 'Unread' })))
  })

  test('an enquiry that is already read is not marked again', async () => {
    serve(detail('a', { unreadByAgent: false }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
    assert.equal(server.callsTo('POST', ACTIONS).length, 0)
  })

  test('a failed mark_read keeps the unread dot (Portal is the source of truth)', async () => {
    serve(detail('a', { unreadByAgent: true }))
    server.on('POST', ACTIONS, { status: 500, error: 'INTERNAL_ERROR' })
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await waitFor(() => assert.equal(server.callsTo('POST', ACTIONS).length, 1))
    assert.ok(screen.getByRole('img', { name: 'Unread' }))
  })

  test('shows the enquiry card: subject, type, status, contact email and body', async () => {
    serve(
      detail('a', {
        subject: 'Video will not play',
        category: 'course_content',
        status: 'WAITING_USER',
        contactEmail: 'contact@example.com',
      }),
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const card = await screen.findByRole('article', { name: 'Video will not play' })
    assert.ok(within(card).getByText('Course Content'))
    assert.ok(within(card).getByText('Waiting for learner'))
    assert.match(within(card).getByText(/contact@example\.com/).textContent ?? '', /^contact@example\.com · /)
    assert.ok(within(card).getByText('Body of a'))
  })
})

describe('Claim and Mark as reviewed', () => {
  test('OPEN shows Claim where Mark as reviewed sits; after claiming, Mark as reviewed shows', async () => {
    serve(
      detail('a', {
        status: 'OPEN',
        sequence: 3,
        available: { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true },
      }),
    )
    const pending = deferred<Reply>()
    server.on('POST', ACTIONS, () => pending.promise)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const claim = await screen.findByRole('button', { name: 'Claim' })
    absent(screen.queryByRole('button', { name: 'Mark as reviewed' }))
    assert.match(claim.getAttribute('title') ?? '', /^Take this enquiry/)

    fireEvent.click(claim)
    const claiming = await screen.findByRole('button', { name: 'Claiming…' })
    assert.equal((claiming as HTMLButtonElement).disabled, true)
    const [call] = server.callsTo('POST', ACTIONS)
    assert.deepEqual(call.body, { action: 'claim', expectedSequence: 3 })

    await act(async () => {
      pending.resolve(
        respondWith({
          status: 'ASSIGNED',
          assignee: { id: 'emp-1', name: 'Agent Smith' },
          available: { claim: false, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: false, flag: true },
        })(call),
      )
    })
    assert.ok(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    absent(screen.queryByRole('button', { name: /Claim/ }))
    assert.ok(screen.getByText('Claimed. The enquiry is assigned to you.'))
    assert.ok(within(conversation()).getByText('In progress'))
  })

  test('Mark as reviewed sends propose_resolution with expectedSequence in one click', async () => {
    serve(detail('a', { status: 'ASSIGNED', sequence: 5 }))
    server.on(
      'POST',
      ACTIONS,
      respondWith({
        status: 'PENDING_CONFIRM',
        available: { claim: false, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true },
      }),
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const button = await screen.findByRole('button', { name: 'Mark as reviewed' })
    assert.match(button.getAttribute('title') ?? '', /closes after 72 hours/)
    fireEvent.click(button)
    await screen.findByText('Marked as reviewed. The learner has been asked to confirm.')
    const calls = server.callsTo('POST', ACTIONS)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { action: 'propose_resolution', expectedSequence: 5 })
    absent(screen.queryByRole('dialog'), 'no confirmation step')
    // Figma 的操作栏始终是 4 个等宽按钮：不可用时保留位置、禁用并说明（待视觉验收）
    const after = await screen.findByRole('button', { name: 'Mark as reviewed' })
    await waitFor(() => assert.equal((after as HTMLButtonElement).disabled, true))
    assert.equal(after.title, 'Not available for this enquiry right now.')
    assert.ok(within(conversation()).getByText('Awaiting confirmation'))
  })

  test('409 STALE_TICKET reloads the enquiry and says it was updated', async () => {
    serve(detail('a', { status: 'ASSIGNED', sequence: 5 }))
    server.on('POST', ACTIONS, () => {
      // 别人刚刚改过：Server 上已是新版本
      tickets.set('a', { ...(tickets.get('a') as EnquiryDetail), subject: 'Updated elsewhere', sequence: 9 })
      return { status: 409, error: 'STALE_TICKET' }
    })
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    assert.ok(await screen.findByText('This enquiry was updated, please check again.'))
    assert.equal(server.callsTo('GET', DETAIL).length, 2, 'reloaded once')
    assert.ok(within(conversation()).getByRole('heading', { name: 'Updated elsewhere' }))
  })

  test('other errors are shown once inline', async () => {
    serve(detail('a'))
    server.on('POST', ACTIONS, { status: 409, error: 'INVALID_TRANSITION' })
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    assert.ok(await screen.findByText('This action is not allowed in the current state.'))
    assert.equal(server.callsTo('GET', DETAIL).length, 1, 'no reload for non-stale errors')
  })

  test('zh-CN: 接单, then 标记为已处理', async () => {
    serve(
      detail('a', {
        status: 'OPEN',
        available: { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true },
      }),
    )
    server.on(
      'POST',
      ACTIONS,
      respondWith({
        status: 'ASSIGNED',
        available: { claim: false, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: false, flag: true },
      }),
    )
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/a' })
    assert.ok(screen.getByRole('heading', { name: '服务台' }))
    assert.ok(screen.getByRole('tab', { name: '工单' }))
    assert.ok(screen.getByRole('tab', { name: '常见问题' }))
    fireEvent.click(await screen.findByRole('button', { name: '接单' }))
    assert.ok(within(conversation()).getByText('待受理'))
    assert.ok(await screen.findByRole('button', { name: '标记为已处理' }))
    assert.ok(screen.getByText('已接单，这条咨询已分配给你。'))
    assert.ok(within(conversation()).getByText('处理中'))
  })
})

describe('Email student and Internal notes (per-card composers)', () => {
  async function openComposer(patch: Partial<EnquiryDetail> = {}) {
    serve(detail('a', { sequence: 4, ...patch }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await card('Subject a')
  }

  test('Email student expands the reply composer; it sends the trimmed body, internal false and expectedSequence', async () => {
    await openComposer({ contactEmail: 'contact@example.com' })
    server.on('POST', MESSAGES, respondWith({}))
    absent(screen.queryByRole('textbox', { name: 'Reply to learner' }), 'collapsed until asked for')
    const button = within(await card('Subject a')).getByRole('button', { name: 'Email student' })
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    const box = await openReply()
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.equal(box.placeholder, 'Write a reply to the learner…')
    assert.ok(screen.getByText('Reply to the student. The reply is saved here and emailed to contact@example.com.'))
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    assert.equal(send.disabled, true, 'empty draft cannot be sent')
    fireEvent.change(box, { target: { value: '  Hello there  ' } })
    assert.ok(screen.getByText('11 / 5000'))
    fireEvent.click(send)
    await waitFor(() => assert.equal(box.value, ''))
    const [call] = server.callsTo('POST', MESSAGES)
    assert.equal(call.path, '/api/helpdesk/tickets/a/messages')
    assert.deepEqual(call.body, { body: 'Hello there', internal: false, expectedSequence: 4 })
    assert.match(call.idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    // 再点一次收起
    fireEvent.click(button)
    absent(screen.queryByRole('textbox', { name: 'Reply to learner' }))
  })

  test('Internal notes expands the card’s notes and the note composer; it sends internal true', async () => {
    await openComposer({
      messages: [
        { id: 'm1', authorKind: 'learner', authorName: '', body: 'First', internal: false, attachments: [], createdAt: '2026-10-28T09:00:00Z' },
        { id: 'm2', authorKind: 'agent', authorName: 'Agent Smith', body: 'VIP learner', internal: true, attachments: [], createdAt: '2026-10-28T09:06:00Z' },
      ],
    })
    server.on('POST', MESSAGES, respondWith({}))
    absent(screen.queryByText('VIP learner'), 'notes stay folded away')
    const button = within(await card('Subject a')).getByRole('button', { name: 'Internal notes' })
    fireEvent.click(button)
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    const panel = screen.getByRole('region', { name: 'Internal notes' })
    const note = within(panel).getByText('VIP learner').closest('article') as HTMLElement
    assert.match(note.className, /hdMsgCardInternal/)
    assert.ok(within(note).getByText('Internal note'))
    assert.ok(within(panel).getByText(/Staff-only notes on this enquiry\. Students never see them\./))
    const box = within(panel).getByRole('textbox', { name: 'Internal note' }) as HTMLTextAreaElement
    assert.equal(box.placeholder, 'Write an internal note (the learner will not see it)…')
    fireEvent.change(box, { target: { value: 'Checked billing' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }))
    await waitFor(() => assert.equal(server.callsTo('POST', MESSAGES).length, 1))
    assert.deepEqual(server.callsTo('POST', MESSAGES)[0].body, {
      body: 'Checked billing',
      internal: true,
      expectedSequence: 4,
    })
  })

  test('no internal notes yet says so', async () => {
    await openComposer()
    fireEvent.click(within(await card('Subject a')).getByRole('button', { name: 'Internal notes' }))
    assert.ok(within(screen.getByRole('region', { name: 'Internal notes' })).getByText('No internal notes yet.'))
  })

  test('replies not allowed: Email student is disabled; Internal notes still works', async () => {
    await openComposer({
      available: { claim: false, reply: false, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true },
    })
    const email = within(await card('Subject a')).getByRole('button', { name: 'Email student' }) as HTMLButtonElement
    assert.equal(email.disabled, true)
    assert.equal(email.title, 'Not available for this enquiry right now.')
    fireEvent.click(within(await card('Subject a')).getByRole('button', { name: 'Internal notes' }))
    assert.ok(screen.getByRole('textbox', { name: 'Internal note' }))
  })

  test('Idempotency-Key is reused only for an unchanged retry; the note composer has its own key', async () => {
    await openComposer()
    const replies: Reply[] = [
      { status: 500, error: 'INTERNAL_ERROR' }, // 1: 首次失败
      { status: 500, error: 'INTERNAL_ERROR' }, // 2: 原样重试
      { status: 500, error: 'INTERNAL_ERROR' }, // 3: 改了正文
      { status: 500, error: 'INTERNAL_ERROR' }, // 4: 同样的文字写成内部备注
    ]
    server.on('POST', MESSAGES, (call) => replies.shift() ?? respondWith({})(call))
    const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const sent = async (count: number) => {
      await waitFor(() => assert.equal(server.callsTo('POST', MESSAGES).length, count))
      await waitFor(() => assert.equal((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).textContent, 'Send'))
    }

    const reply = await openReply()
    fireEvent.change(reply, { target: { value: 'Hello' } })
    send()
    await sent(1)
    assert.ok(screen.getByText('Something went wrong. Please try again.'))
    assert.equal(reply.value, 'Hello', 'draft kept after failure')
    send()
    await sent(2)
    fireEvent.change(reply, { target: { value: 'Hello again' } })
    send()
    await sent(3)
    // 换到内部备注：同样的文字是另一次提交
    fireEvent.click(within(await card('Subject a')).getByRole('button', { name: 'Internal notes' }))
    const note = screen.getByRole('textbox', { name: 'Internal note' })
    fireEvent.change(note, { target: { value: 'Hello again' } })
    send()
    await sent(4)
    // 5: 原样重试成功；6: 成功后同样的内容是新的一次提交
    send()
    await sent(5)
    fireEvent.change(screen.getByRole('textbox', { name: 'Internal note' }), { target: { value: 'Hello again' } })
    send()
    await sent(6)

    const keys = server.callsTo('POST', MESSAGES).map((call) => call.idempotencyKey)
    assert.equal(keys[1], keys[0], 'unchanged retry reuses the key')
    assert.notEqual(keys[2], keys[1], 'changed body gets a new key')
    assert.notEqual(keys[3], keys[2], 'a note is a different submission')
    assert.equal(keys[4], keys[3], 'unchanged retry reuses the key')
    assert.notEqual(keys[5], keys[4], 'after success the next send gets a new key')
    assert.equal(new Set(keys).size, 4)
    assert.deepEqual(
      server.callsTo('POST', MESSAGES).map((call) => (call.body as { internal: boolean }).internal),
      [false, false, false, true, true, true],
    )
  })

  test('the reply draft survives folding the composer away and back', async () => {
    await openComposer()
    fireEvent.change(await openReply(), { target: { value: 'Half way' } })
    const button = within(await card('Subject a')).getByRole('button', { name: 'Email student' })
    fireEvent.click(button)
    fireEvent.click(button)
    assert.equal((screen.getByRole('textbox', { name: 'Reply to learner' }) as HTMLTextAreaElement).value, 'Half way')
  })

  test('Ctrl/Cmd+Enter sends; plain Enter and IME composition do not', async () => {
    await openComposer()
    server.on('POST', MESSAGES, respondWith({}))
    const box = await openReply()
    fireEvent.change(box, { target: { value: '你好' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, keyCode: 229 })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true })
    assert.equal(server.callsTo('POST', MESSAGES).length, 0)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => assert.equal(server.callsTo('POST', MESSAGES).length, 1))
  })

  test('over 5000 characters cannot be sent', async () => {
    await openComposer()
    fireEvent.change(await openReply(), { target: { value: 'x'.repeat(5001) } })
    assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true)
    assert.equal(screen.getByText('5001 / 5000').className, 'hdTooLong')
  })

  test('the selected card shows its conversation: agent replies and system lines (notes only in the notes panel)', async () => {
    await openComposer({
      messages: [
        { id: 'm1', authorKind: 'learner', authorName: '', body: 'First', internal: false, attachments: [], createdAt: '2026-10-28T09:00:00Z' },
        { id: 'm2', authorKind: 'agent', authorName: 'Agent Smith', body: 'On it', internal: false, attachments: [], createdAt: '2026-10-28T09:05:00Z' },
        { id: 'm3', authorKind: 'agent', authorName: 'Agent Smith', body: 'VIP learner', internal: true, attachments: [], createdAt: '2026-10-28T09:06:00Z' },
        { id: 'm4', authorKind: 'system', authorName: '', body: 'Status changed', internal: false, attachments: [], createdAt: '2026-10-28T09:07:00Z' },
      ],
    })
    const entry = item(await card('Subject a'))
    assert.ok(within(entry).getByText('First'), 'the first learner message is the card body')
    const reply = within(entry).getByText('On it').closest('article') as HTMLElement
    assert.match(reply.className, /hdMsgCardAgent/)
    assert.equal(within(entry).getByText('Status changed').className, 'hdSystemLine')
    absent(within(entry).queryByText('VIP learner'))
  })
})

describe('responses for an enquiry that is no longer selected', () => {
  test('a reply that lands after switching only updates that row, never the open enquiry', async () => {
    serve(detail('a'), detail('b', { subject: 'Second enquiry' }))
    const pending = deferred<Reply>()
    server.on('POST', MESSAGES, () => pending.promise)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.change(await openReply(), { target: { value: 'Reply for A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Sending…' })

    fireEvent.click(await listRow('Second enquiry'))
    await screen.findByRole('article', { name: 'Second enquiry' })
    // A 的写操作还在跑，但不禁用 B 的按钮
    assert.equal((screen.getByRole('button', { name: 'Mark as reviewed' }) as HTMLButtonElement).disabled, false)

    const [call] = server.callsTo('POST', MESSAGES)
    await act(async () => {
      pending.resolve(respondWith({ subject: 'A after reply' })(call))
    })
    assert.ok(within(conversation()).getByRole('heading', { name: 'Second enquiry' }))
    absent(within(conversation()).queryByText('Body of a'))
    absent(document.querySelector('.hdNotice'), 'no notice on B')
    assert.ok(await listRow('A after reply'), 'left row for A is updated')
  })

  test('an error for the old enquiry does not show on the new one', async () => {
    serve(detail('a'), detail('b', { subject: 'Second enquiry' }))
    const pending = deferred<Reply>()
    server.on('POST', ACTIONS, () => pending.promise)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    fireEvent.click(await listRow('Second enquiry'))
    await screen.findByRole('article', { name: 'Second enquiry' })
    await act(async () => {
      pending.resolve({ status: 409, error: 'STALE_TICKET' })
    })
    absent(document.querySelector('.hdNotice'))
    assert.equal(server.callsTo('GET', /\/tickets\/a$/).length, 1, 'no reload of A')
  })

  test('a slow detail response for the previous enquiry does not replace the current one', async () => {
    serve(detail('a'), detail('b', { subject: 'Second enquiry' }))
    const slowA = deferred<Reply>()
    server.on('GET', /\/tickets\/a$/, () => slowA.promise)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await screen.findByText('Subject a')
    fireEvent.click(await listRow('Second enquiry'))
    await screen.findByRole('article', { name: 'Second enquiry' })
    await act(async () => {
      slowA.resolve({ data: detail('a') })
    })
    assert.ok(within(conversation()).getByRole('heading', { name: 'Second enquiry' }))
  })
})

describe('tags', () => {
  async function openTags(tags: string[] = ['refund']) {
    serve(detail('a', { tags, sequence: 6 }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
  }

  test('Add Tag sends the normalised tag with expectedSequence; IME composition Enter is ignored', async () => {
    await openTags()
    server.on('POST', ACTIONS, (call) => respondWith({ tags: ['refund', (call.body as { tag: string }).tag] })(call))
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    const input = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(input, { target: { value: '  VIP   customer ' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    assert.equal(server.callsTo('POST', ACTIONS).length, 0, 'composition Enter belongs to the IME')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => assert.equal(server.callsTo('POST', ACTIONS).length, 1))
    assert.deepEqual(server.callsTo('POST', ACTIONS)[0].body, {
      action: 'add_tag',
      tag: 'VIP customer',
      expectedSequence: 6,
    })
    await waitFor(() => absent(screen.queryByRole('textbox', { name: 'New tag' })))
    assert.ok(screen.getByText('VIP customer'))
  })

  test('duplicate and invalid tags are rejected locally; Escape cancels', async () => {
    await openTags()
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    const input = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(input, { target: { value: 'REFUND' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    assert.ok(screen.getByText('This tag is already on the enquiry.'))
    fireEvent.change(input, { target: { value: 'x'.repeat(33) } })
    absent(screen.queryByText('This tag is already on the enquiry.'), 'error clears on edit')
    fireEvent.keyDown(input, { key: 'Enter' })
    assert.ok(screen.getByText('Tags are 1–32 characters.'))
    assert.equal(server.callsTo('POST', ACTIONS).length, 0)
    fireEvent.keyDown(input, { key: 'Escape' })
    absent(screen.queryByRole('textbox', { name: 'New tag' }))
  })

  test('the 11th tag is refused locally', async () => {
    await openTags(Array.from({ length: 10 }, (_, i) => `t${i}`))
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    const input = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(input, { target: { value: 'one more' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    assert.ok(screen.getByText('An enquiry can have up to 10 tags.'))
    assert.equal(server.callsTo('POST', ACTIONS).length, 0)
  })

  test('removing a tag sends remove_tag with expectedSequence', async () => {
    await openTags(['refund', 'vip'])
    server.on('POST', ACTIONS, respondWith({ tags: ['vip'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag refund' }))
    await waitFor(() => absent(screen.queryByText('refund')))
    assert.deepEqual(server.callsTo('POST', ACTIONS)[0].body, { action: 'remove_tag', tag: 'refund', expectedSequence: 6 })
  })

  test('a failed add keeps the editor open with the typed value', async () => {
    await openTags()
    server.on('POST', ACTIONS, { status: 409, error: 'TAG_LIMIT_REACHED' })
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    const input = screen.getByRole('textbox', { name: 'New tag' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'vip' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    assert.ok(await screen.findByText('An enquiry can have up to 10 tags.'))
    assert.equal((screen.getByRole('textbox', { name: 'New tag' }) as HTMLInputElement).value, 'vip')
  })
})

describe('VIEW role (no write controls anywhere)', () => {
  test('enquiries: read-only banner, no Add FAQ, no action bar, composer or tag controls, no mark_read', async () => {
    serve(
      detail('a', {
        status: 'OPEN',
        unreadByAgent: true,
        tags: ['refund'],
        // 即使 Server 误给了可用操作，VIEW 也不显示
        available: { claim: true, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: true, flag: true },
        messages: [
          { id: 'm1', authorKind: 'learner', authorName: '', body: 'Body of a', internal: false, attachments: [], createdAt: '2026-10-28T09:00:00Z' },
          { id: 'm2', authorKind: 'agent', authorName: 'Agent Smith', body: 'VIP learner', internal: true, attachments: [], createdAt: '2026-10-28T09:06:00Z' },
        ],
        aiAssist: [
          { id: 'ai1', source: 'chat', question: 'Q', faqId: 'f1', faqQuestion: 'F', answer: 'Try **this**', feedback: 'helpful', createdAt: '2026-10-28T08:59:00Z' },
        ],
      }),
    )
    await renderHelpDesk(server, { role: 'COURSE_CREATOR', path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
    assert.ok(screen.getByText('Your role can view Help Desk but cannot reply or change anything.'))
    for (const name of [/Add FAQ/, /Claim/, /Mark as reviewed/, /Email student/, /Internal notes/, /Flag follow-up/, /Add Tag/, /Remove tag/, /Send/]) {
      absent(screen.queryByRole('button', { name }), String(name))
    }
    absent(document.querySelector('.hdActionBar'), 'the whole action bar is hidden')
    // VIEW 看得到全部内容：内部备注直接显示在对话里（只读），AI 块也在
    const note = screen.getByText('VIP learner').closest('article') as HTMLElement
    assert.match(note.className, /hdMsgCardInternal/)
    assert.ok(screen.getByRole('region', { name: 'AI Support Assistant' }))
    absent(screen.queryByRole('textbox', { name: /Reply|Internal/ }))
    absent(screen.queryByRole('radio'))
    assert.ok(screen.getByText('refund'), 'tags are still visible')
    // 读完详情后也没有任何写请求（打开不清未读）
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(
      server.calls.filter((call) => call.method !== 'GET').map((call) => call.path),
      [],
    )
    assert.ok(screen.getByRole('img', { name: 'Unread' }))
  })

  test('FULL role sees the write controls on the same enquiry (control for the VIEW test)', async () => {
    serve(detail('a', { tags: ['refund'] }))
    await renderHelpDesk(server, { role: 'OPERATION_ADMIN', path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
    absent(screen.queryByText('Your role can view Help Desk but cannot reply or change anything.'))
    for (const name of [/Add FAQ/, /Mark as reviewed/, /Email student/, /Internal notes/, /Flag follow-up/, /Add Tag/, /Remove tag refund/]) {
      assert.ok(screen.getByRole('button', { name }), String(name))
    }
  })
})

describe('paging, attachments and tabs', () => {
  test('scrolling to the end loads the next page with the cursor and merges rows without duplicates', async () => {
    // jsdom 没有 IntersectionObserver：换成一观察就报「进入可视区」的版本
    const observed: Element[] = []
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(element: Element) {
        observed.push(element)
        this.callback([{ isIntersecting: true }])
      }
      disconnect() {}
    }
    try {
      server.on('GET', LIST, (call) =>
        call.query.get('cursor') === 'page-2'
          ? { data: { tickets: [row('b', { subject: 'B moved' }), row('c', { subject: 'Third' })], nextCursor: null, counts: {} } }
          : { data: { tickets: [row('a'), row('b')], nextCursor: 'page-2', counts: {} } },
      )
      await renderHelpDesk(server, { path: '/en-GB/help-desk?status=OPEN' })
      await listRow('Third')
      const calls = server.callsTo('GET', LIST)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].query.get('cursor'), 'page-2')
      assert.equal(calls[1].query.get('status'), 'OPEN', 'same filters on the next page')
      const subjects = Array.from(document.querySelectorAll('.hdRowSubject'), (node) => node.textContent)
      assert.deepEqual(subjects, ['Subject a', 'B moved', 'Third'])
      assert.ok(observed.length >= 1)
    } finally {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
    }
  })

  test('a failed next page shows the error and stops paging', async () => {
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }])
      }
      disconnect() {}
    }
    try {
      server.on('GET', LIST, (call) =>
        call.query.get('cursor')
          ? { status: 503, error: 'HELPDESK_UNAVAILABLE' }
          : { data: { tickets: [row('a')], nextCursor: 'page-2', counts: {} } },
      )
      await renderHelpDesk(server, { path: '/en-GB/help-desk' })
      assert.equal((await screen.findByRole('alert')).textContent, 'HelpDesk is unavailable right now. Please try again.')
      assert.ok(await listRow('Subject a'), 'first page stays')
      assert.equal(server.callsTo('GET', LIST).length, 2)
    } finally {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
    }
  })

  test('attachments open through the BackOffice proxy in a new tab with name and size', async () => {
    serve(
      detail('a', {
        messages: [
          {
            id: 'm1',
            authorKind: 'learner',
            authorName: '',
            body: 'See attached',
            internal: false,
            attachments: [{ id: 'att 1', fileName: 'report.pdf', contentType: 'application/pdf', size: 250880, inline: false }],
            createdAt: '2026-10-28T09:00:00Z',
          },
        ],
      }),
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const link = await screen.findByRole('link', { name: 'Open attachment report.pdf' })
    assert.equal(link.getAttribute('href'), '/api/helpdesk/attachments/att%201')
    assert.equal(link.getAttribute('target'), '_blank')
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
    assert.ok(within(link).getByText('245 KB'))
  })

  test('tabs switch between Enquiries and FAQs in the URL', async () => {
    serve(detail('a'))
    server.on('GET', '/api/helpdesk/faqs', { data: { faqs: [], total: 0, page: 1, pageSize: 10 } })
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    const enquiries = screen.getByRole('tab', { name: 'Enquiries' })
    assert.equal(enquiries.getAttribute('aria-selected'), 'true')
    fireEvent.click(enquiries)
    assert.equal(location.current, '/en-GB/help-desk', 'clicking the open tab does nothing')
    fireEvent.click(screen.getByRole('tab', { name: 'FAQs' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?tab=faqs'))
    assert.ok(await screen.findByText('No FAQs yet.'))
    fireEvent.click(screen.getByRole('tab', { name: 'Enquiries' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk'))
    assert.ok(await listRow('Subject a'))
  })

  test('an enquiry link wins over ?tab=faqs (and the legacy ?tab=questions)', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a?tab=faqs' })
    assert.ok(await screen.findByRole('article', { name: 'Subject a' }))
    assert.equal(screen.getByRole('tab', { name: 'Enquiries' }).getAttribute('aria-selected'), 'true')
    cleanup()
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a?tab=questions' })
    assert.ok(await screen.findByRole('article', { name: 'Subject a' }))
    assert.equal(screen.getByRole('tab', { name: 'Enquiries' }).getAttribute('aria-selected'), 'true')
  })
})

describe('student timeline (Figma 1324:2 middle column)', () => {
  function threeForLena() {
    return [
      sameLearner('a', { subject: 'Newest', createdAt: '2026-10-28T14:32:00Z', category: 'technical_support' }),
      sameLearner('b', { subject: 'Older same day', createdAt: '2026-10-28T09:15:00Z', category: 'payments_subscriptions', sequence: 8 }),
      sameLearner('c', { subject: 'Last week', createdAt: '2026-10-21T10:00:00Z' }),
      detail('z', { subject: 'Someone else' }),
    ]
  }

  test('shows the learner’s enquiries newest first under date separators; other learners stay out', async () => {
    serve(...threeForLena())
    await renderHelpDesk(server, { path: '/en-GB/help-desk/b' })
    await card('Older same day')
    await card('Newest')
    const timelineCall = server.callsTo('GET', LIST).find((call) => call.query.has('learnerId')) as Call
    assert.deepEqual(Object.fromEntries(timelineCall.query), { learnerId: 'user-l', limit: '10' })
    const timeline = screen.getByRole('region', { name: 'Enquiries from Lena Learner' })
    assert.deepEqual(
      within(timeline).getAllByRole('article').filter((node) => node.classList.contains('hdEnquiryCard')).map((node) => node.getAttribute('aria-label')),
      ['Newest', 'Older same day', 'Last week'],
    )
    assert.deepEqual(
      Array.from(timeline.querySelectorAll('.hdDateSep'), (node) => node.textContent),
      ['28 Oct 2026', '21 Oct 2026'],
    )
    absent(within(timeline).queryByRole('article', { name: 'Someone else' }))
    // 选中的那张是当前卡片
    assert.equal((await card('Older same day')).getAttribute('aria-current'), 'true')
    assert.equal((await card('Newest')).getAttribute('aria-current'), null)
    // 卡片：类型标签、「联系邮箱 · HH:mm」、正文（未展开的卡片用摘要）
    const older = await card('Older same day')
    assert.ok(within(older).getByText('Payments & Subscriptions'))
    assert.equal(within(older).getByText(/^l@example\.com · /).textContent, 'l@example.com · 09:15')
    assert.ok(within(older).getByText('Body of b'))
  })

  test('the other cards load their detail once (read only, no mark_read) to show body and AI blocks', async () => {
    const [a, b, c, z] = threeForLena()
    serve(
      { ...a, unreadByAgent: true, aiAssist: [{ id: 'ai-a', source: 'chat', question: 'Q', faqId: 'f1', faqQuestion: 'F', answer: 'Answer for a', feedback: 'helpful', createdAt: a.createdAt }] },
      b,
      c,
      z,
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/b' })
    const newest = item(await card('Newest'))
    assert.ok(await within(newest).findByText('Body of a'))
    assert.ok(within(newest).getByRole('region', { name: 'AI Support Assistant' }))
    assert.equal(server.callsTo('GET', /\/tickets\/a$/).length, 1)
    assert.equal(server.callsTo('GET', /\/tickets\/b$/).length, 1, 'the selected one is not fetched twice')
    assert.equal(server.callsTo('GET', /\/tickets\/z$/).length, 0, 'other learners are not fetched')
    assert.deepEqual(server.calls.filter((call) => call.method !== 'GET'), [], 'no mark_read for cards that are not opened')
  })

  test('clicking another card opens it (URL keeps the filters) and loads its detail', async () => {
    serve(...threeForLena())
    await renderHelpDesk(server, { path: '/en-GB/help-desk/b?status=ASSIGNED' })
    const newest = await card('Newest')
    fireEvent.click(within(newest).getByRole('button', { name: 'Newest' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk/a?status=ASSIGNED'))
    // 已预取过一次；打开时再取一次最新的
    await waitFor(() => assert.equal(server.callsTo('GET', /\/tickets\/a$/).length, 2))
    await waitFor(async () => assert.equal((await card('Newest')).getAttribute('aria-current'), 'true'))
    assert.ok(within(await card('Newest')).getByText('Body of a'))
  })

  test('every card has the 4-button action bar in Figma order', async () => {
    serve(...threeForLena())
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    for (const subject of ['Newest', 'Older same day', 'Last week']) {
      const bar = within(await card(subject)).getByRole('group', { name: 'Actions' })
      assert.deepEqual(
        within(bar).getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim()),
        ['✓ Mark as reviewed', '✉ Email student', '▤ Internal notes', '⚑ Flag follow-up'],
        subject,
      )
    }
  })

  test('Mark as reviewed on another card acts on that enquiry with its own sequence', async () => {
    serve(...threeForLena())
    server.on('POST', ACTIONS, respondWith({ status: 'PENDING_CONFIRM' }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.click(within(await card('Older same day')).getByRole('button', { name: 'Mark as reviewed' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACTIONS).length, 1))
    const [call] = server.callsTo('POST', ACTIONS)
    assert.equal(call.path, '/api/helpdesk/tickets/b/actions')
    assert.deepEqual(call.body, { action: 'propose_resolution', expectedSequence: 8 })
    assert.ok(await within(item(await card('Older same day'))).findByText('Marked as reviewed. The learner has been asked to confirm.'))
    assert.ok(within(await card('Older same day')).getByText('Awaiting confirmation'))
    assert.equal(location.current, '/en-GB/help-desk/a', 'the selection does not move')
  })

  test('Email student on another card opens that enquiry with its composer expanded', async () => {
    serve(...threeForLena())
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    fireEvent.click(within(await card('Last week')).getByRole('button', { name: 'Email student' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk/c'))
    const box = await waitFor(() => within(item(within(conversation()).getByRole('article', { name: 'Last week' }))).getByRole('textbox', { name: 'Reply to learner' }))
    assert.ok(box)
  })

  test('the selected enquiry is visible even when it is older than the newest 10', async () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      sameLearner(`n${i}`, { subject: `Recent ${i}`, createdAt: `2026-10-${String(10 + i).padStart(2, '0')}T10:00:00Z` }),
    )
    serve(sameLearner('old', { subject: 'Very old', createdAt: '2026-01-01T10:00:00Z' }), ...many)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/old' })
    assert.ok(await card('Very old'))
    await card('Recent 10')
    absent(within(conversation()).queryByRole('article', { name: 'Recent 0' }), 'only the newest 10 others')
  })

  test('if the timeline cannot load, the selected card still shows', async () => {
    serve(detail('a'))
    server.on('GET', LIST, (call) =>
      call.query.has('learnerId') ? { status: 503, error: 'HELPDESK_UNAVAILABLE' } : { data: { tickets: [row('a')], nextCursor: null, counts: {} } },
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    assert.ok(await card('Subject a'))
  })
})

describe('Flag follow-up', () => {
  test('toggles flag / unflag with expectedSequence; the button shows the pressed state', async () => {
    serve(detail('a', { sequence: 3 }))
    server.on('POST', ACTIONS, (call) => respondWith({ flagged: (call.body as { action: string }).action === 'flag' })(call))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const flag = within(await card('Subject a')).getByRole('button', { name: 'Flag follow-up' })
    assert.equal(flag.getAttribute('aria-pressed'), 'false')
    assert.equal(flag.title, 'Flag this enquiry to follow up later.')
    fireEvent.click(flag)
    await waitFor(() => assert.equal(flag.getAttribute('aria-pressed'), 'true'))
    assert.deepEqual(server.callsTo('POST', ACTIONS)[0].body, { action: 'flag', expectedSequence: 3 })
    assert.ok(screen.getByText('Flagged for follow-up.'))
    assert.equal(flag.title, 'Flagged for follow-up. Click to remove the flag.')
    // 左栏那一行出现小旗子
    assert.ok(within(await listRow('Subject a')).getByRole('img', { name: 'Flagged for follow-up' }))
    fireEvent.click(flag)
    await waitFor(() => assert.equal(flag.getAttribute('aria-pressed'), 'false'))
    assert.deepEqual(server.callsTo('POST', ACTIONS)[1].body, { action: 'unflag', expectedSequence: 4 })
    assert.ok(screen.getByText('Flag removed.'))
  })

  test('the Flagged filter goes into the URL and the request', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    await listRow('Subject a')
    fireEvent.click(screen.getByRole('button', { name: /Filter enquiries/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Flagged' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?flagged=true'))
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).at(-1)?.query.get('flagged'), 'true'))
  })

  test('zh-CN action bar copy', async () => {
    serve(detail('a', { status: 'OPEN', available: { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true } }))
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/a' })
    const bar = within(await card('Subject a')).getByRole('group', { name: '操作' })
    assert.deepEqual(
      within(bar).getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim()),
      ['✓ 接单', '✉ 给学员发邮件', '▤ 内部备注', '⚑ 标记跟进'],
    )
  })
})

describe('AI blocks (aiAssist after each card)', () => {
  const at = '2026-10-28T08:50:00Z'
  function assist(id: string, patch: Partial<EnquiryDetail['aiAssist'][number]>): EnquiryDetail['aiAssist'][number] {
    return { id, source: 'chat', question: `Asked ${id}`, faqId: 'f1', faqQuestion: 'FAQ', answer: `Answer **${id}**`, feedback: null, createdAt: at, ...patch }
  }

  test('each block has the title, the AI-generated tag, the rendered answer and the feedback line', async () => {
    serve(
      detail('a', {
        aiAssist: [
          assist('helpful', { feedback: 'helpful' }),
          assist('not_helpful', { feedback: 'not_helpful' }),
          assist('declined', { source: 'submit', feedback: 'declined' }),
          assist('solved', { source: 'submit', feedback: 'solved' }),
          assist('none', { feedback: null }),
          assist('edited', { source: 'submit', feedback: 'edited' }),
          assist('empty', { answer: null, faqId: null }),
        ],
      }),
    )
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const entry = item(await card('Subject a'))
    const blocks = within(entry).getAllByRole('region', { name: 'AI Support Assistant' })
    assert.equal(blocks.length, 7)
    for (const block of blocks) {
      assert.ok(within(block).getByText('AI-generated'))
    }
    assert.equal(within(blocks[0]).getByText('helpful').tagName, 'STRONG', 'answer goes through the shared renderer')
    const feedback = blocks.map((block) => {
      const line = block.querySelector('.hdAiFeedback')
      return line ? [line.textContent?.replace(/\s+/g, ' ').trim(), line.classList.contains('hdAiFeedbackPositive') ? 'green' : 'red'] : null
    })
    assert.deepEqual(feedback, [
      ['✓ Student feedback: Yes, this solved my issue', 'green'],
      ['✕ Student feedback: No, I still submit to support team', 'red'],
      ['✕ Student feedback: No, I still submit to support team', 'red'],
      ['✓ Student feedback: Yes, this solved my issue', 'green'],
      null,
      null,
      null,
    ])
    assert.ok(within(blocks[6]).getByText('No FAQ matched, so the assistant showed no answer.'))
    // 卡片在前，AI 块在后
    const cardElement = await card('Subject a')
    assert.ok(cardElement.compareDocumentPosition(blocks[0]) & Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('zh-CN feedback copy', async () => {
    serve(detail('a', { aiAssist: [assist('h', { feedback: 'helpful' }), assist('n', { feedback: 'not_helpful' })] }))
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/a' })
    const entry = item(await card('Subject a'))
    const blocks = within(entry).getAllByRole('region', { name: 'AI 客服助手' })
    assert.ok(within(blocks[0]).getByText('AI 生成'))
    assert.match(blocks[0].querySelector('.hdAiFeedback')?.textContent ?? '', /学生反馈：已解决/)
    assert.match(blocks[1].querySelector('.hdAiFeedback')?.textContent ?? '', /学生反馈：仍提交给客服/)
  })

  test('a raw HTML answer is shown as text', async () => {
    serve(detail('a', { aiAssist: [assist('x', { answer: '<img src=x onerror=alert(1)>' })] }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    const block = within(item(await card('Subject a'))).getByRole('region', { name: 'AI Support Assistant' })
    absent(block.querySelector('img'))
    assert.ok(within(block).getByText('<img src=x onerror=alert(1)>'))
  })
})
