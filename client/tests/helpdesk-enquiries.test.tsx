import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { EnquiryDetail } from '../src/backoffice/contracts/helpdesk'
import { absent, deferred, detail, installFakeServer, row, type Call, type FakeServer, type Reply } from './support/helpdesk-fake'
import { location, renderHelpDesk } from './support/helpdesk-render'

/**
 * Enquiries 三栏（HelpDeskPage → EnquiriesView → EnquiryList / EnquiryConversation / StudentPanel），
 * 走真实路由、真实 RBAC、真实 helpdeskApi，只把 fetch 换成假的 BackOffice Server。
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

/** 列表 + 详情从同一份内存数据应答。 */
function serve(...items: EnquiryDetail[]) {
  tickets = new Map(items.map((item) => [item.id, item]))
  server.on('GET', LIST, () => ({ data: { tickets: [...tickets.values()], nextCursor: null, counts: {} } }))
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
        available: { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false },
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
          available: { claim: false, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: false },
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
        available: { claim: false, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false },
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
    absent(screen.queryByRole('button', { name: 'Mark as reviewed' }))
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
        available: { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: false },
      }),
    )
    server.on(
      'POST',
      ACTIONS,
      respondWith({
        status: 'ASSIGNED',
        available: { claim: false, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: false },
      }),
    )
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/a' })
    assert.ok(screen.getByRole('heading', { name: '服务台' }))
    assert.ok(screen.getByRole('tab', { name: '咨询' }))
    assert.ok(screen.getByRole('tab', { name: '常见问题' }))
    fireEvent.click(await screen.findByRole('button', { name: '接单' }))
    assert.ok(within(conversation()).getByText('待受理'))
    assert.ok(await screen.findByRole('button', { name: '标记为已处理' }))
    assert.ok(screen.getByText('已接单，这条咨询已分配给你。'))
    assert.ok(within(conversation()).getByText('处理中'))
  })
})

describe('composer', () => {
  async function openComposer(patch: Partial<EnquiryDetail> = {}) {
    serve(detail('a', { sequence: 4, ...patch }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
  }

  test('reply sends trimmed body, internal false and expectedSequence; success clears the draft', async () => {
    await openComposer()
    server.on('POST', MESSAGES, respondWith({}))
    assert.equal(screen.getByRole('radio', { name: 'Reply to learner' }).getAttribute('aria-checked'), 'true')
    const box = screen.getByRole('textbox', { name: 'Reply to learner' }) as HTMLTextAreaElement
    assert.equal(box.placeholder, 'Write a reply to the learner…')
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
  })

  test('internal note mode sends internal true and shows the staff-only hint', async () => {
    await openComposer()
    server.on('POST', MESSAGES, respondWith({}))
    fireEvent.click(screen.getByRole('radio', { name: 'Internal note' }))
    const box = screen.getByRole('textbox', { name: 'Internal note' }) as HTMLTextAreaElement
    assert.equal(box.placeholder, 'Write an internal note (the learner will not see it)…')
    assert.ok(screen.getByText(/Internal notes are only visible to staff\./))
    fireEvent.change(box, { target: { value: 'Checked billing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => assert.equal(server.callsTo('POST', MESSAGES).length, 1))
    assert.deepEqual(server.callsTo('POST', MESSAGES)[0].body, {
      body: 'Checked billing',
      internal: true,
      expectedSequence: 4,
    })
  })

  test('only internal notes allowed: the composer starts in note mode with no reply option', async () => {
    await openComposer({
      available: { claim: false, reply: false, internalNote: true, proposeResolution: false, tag: true, markRead: false },
    })
    absent(screen.queryByRole('radio', { name: 'Reply to learner' }))
    assert.equal(screen.getByRole('radio', { name: 'Internal note' }).getAttribute('aria-checked'), 'true')
  })

  test('Idempotency-Key is reused only for an unchanged retry', async () => {
    await openComposer()
    const replies: Reply[] = [
      { status: 500, error: 'INTERNAL_ERROR' }, // 1: 首次失败
      { status: 500, error: 'INTERNAL_ERROR' }, // 2: 原样重试
      { status: 500, error: 'INTERNAL_ERROR' }, // 3: 改了正文
      { status: 500, error: 'INTERNAL_ERROR' }, // 4: 改成内部备注
    ]
    server.on('POST', MESSAGES, (call) => replies.shift() ?? respondWith({})(call))
    const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const sent = async (count: number) => {
      await waitFor(() => assert.equal(server.callsTo('POST', MESSAGES).length, count))
      await waitFor(() => assert.equal((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).textContent, 'Send'))
    }

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to learner' }), { target: { value: 'Hello' } })
    send()
    await sent(1)
    assert.ok(screen.getByText('Something went wrong. Please try again.'))
    assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'Hello', 'draft kept after failure')
    send()
    await sent(2)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello again' } })
    send()
    await sent(3)
    fireEvent.click(screen.getByRole('radio', { name: 'Internal note' }))
    send()
    await sent(4)
    // 5: 原样重试成功；6: 成功后同样的内容是新的一次提交
    send()
    await sent(5)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello again' } })
    send()
    await sent(6)

    const keys = server.callsTo('POST', MESSAGES).map((call) => call.idempotencyKey)
    assert.equal(keys[1], keys[0], 'unchanged retry reuses the key')
    assert.notEqual(keys[2], keys[1], 'changed body gets a new key')
    assert.notEqual(keys[3], keys[2], 'changed mode gets a new key')
    assert.equal(keys[4], keys[3], 'unchanged retry reuses the key')
    assert.notEqual(keys[5], keys[4], 'after success the next send gets a new key')
    assert.equal(new Set(keys).size, 4)
  })

  test('Ctrl/Cmd+Enter sends; plain Enter and IME composition do not', async () => {
    await openComposer()
    server.on('POST', MESSAGES, respondWith({}))
    const box = screen.getByRole('textbox')
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } })
    assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true)
    assert.equal(screen.getByText('5001 / 5000').className, 'hdTooLong')
  })

  test('shows later messages: agent replies and internal notes, system lines', async () => {
    await openComposer({
      messages: [
        { id: 'm1', authorKind: 'learner', authorName: '', body: 'First', internal: false, attachments: [], createdAt: '2026-10-28T09:00:00Z' },
        { id: 'm2', authorKind: 'agent', authorName: 'Agent Smith', body: 'On it', internal: false, attachments: [], createdAt: '2026-10-28T09:05:00Z' },
        { id: 'm3', authorKind: 'agent', authorName: 'Agent Smith', body: 'VIP learner', internal: true, attachments: [], createdAt: '2026-10-28T09:06:00Z' },
        { id: 'm4', authorKind: 'system', authorName: '', body: 'Status changed', internal: false, attachments: [], createdAt: '2026-10-28T09:07:00Z' },
      ],
    })
    assert.ok(screen.getByText('On it'))
    const note = screen.getByText('VIP learner').closest('article') as HTMLElement
    assert.match(note.className, /hdMsgCardInternal/)
    assert.ok(within(note).getByText('Internal note'))
    assert.equal(screen.getByText('Status changed').className, 'hdSystemLine')
  })
})

describe('responses for an enquiry that is no longer selected', () => {
  test('a reply that lands after switching only updates that row, never the open enquiry', async () => {
    serve(detail('a'), detail('b', { subject: 'Second enquiry' }))
    const pending = deferred<Reply>()
    server.on('POST', MESSAGES, () => pending.promise)
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reply for A' } })
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
  test('enquiries: read-only banner, no Add Question, Claim, Mark as reviewed, composer or tag controls, no mark_read', async () => {
    serve(
      detail('a', {
        status: 'OPEN',
        unreadByAgent: true,
        tags: ['refund'],
        // 即使 Server 误给了可用操作，VIEW 也不显示
        available: { claim: true, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: true },
      }),
    )
    await renderHelpDesk(server, { role: 'COURSE_CREATOR', path: '/en-GB/help-desk/a' })
    await screen.findByRole('article', { name: 'Subject a' })
    assert.ok(screen.getByText('Your role can view Help Desk but cannot reply or change anything.'))
    for (const name of [/Add Question/, /Claim/, /Mark as reviewed/, /Add Tag/, /Remove tag/, /Send/]) {
      absent(screen.queryByRole('button', { name }), String(name))
    }
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
    for (const name of [/Add Question/, /Mark as reviewed/, /Add Tag/, /Remove tag refund/, /Send/]) {
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

  test('tabs switch between Enquiries and Common Questions in the URL', async () => {
    serve(detail('a'))
    server.on('GET', '/api/helpdesk/questions', { data: { questions: [] } })
    await renderHelpDesk(server, { path: '/en-GB/help-desk' })
    const enquiries = screen.getByRole('tab', { name: 'Enquiries' })
    assert.equal(enquiries.getAttribute('aria-selected'), 'true')
    fireEvent.click(enquiries)
    assert.equal(location.current, '/en-GB/help-desk', 'clicking the open tab does nothing')
    fireEvent.click(screen.getByRole('tab', { name: 'Common Questions' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?tab=questions'))
    assert.ok(await screen.findByText('No common questions yet.'))
    fireEvent.click(screen.getByRole('tab', { name: 'Enquiries' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk'))
    assert.ok(await listRow('Subject a'))
  })

  test('an enquiry link wins over ?tab=questions', async () => {
    serve(detail('a'))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/a?tab=questions' })
    assert.ok(await screen.findByRole('article', { name: 'Subject a' }))
    assert.equal(screen.getByRole('tab', { name: 'Enquiries' }).getAttribute('aria-selected'), 'true')
  })
})
