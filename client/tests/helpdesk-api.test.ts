import test, { afterEach, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  attachmentUrl,
  createQuestion,
  getEnquiry,
  getQuestion,
  listEnquiries,
  listQuestions,
  newIdempotencyKey,
  reorderQuestions,
  sendAction,
  sendMessage,
  transitionQuestion,
  updateQuestion,
} from '../src/backoffice/lib/helpdeskApi'

type Call = { url: string; init: RequestInit }

let calls: Call[] = []
let reply: () => Promise<Response> = async () => envelope({})
let sessionEvents = 0
const realFetch = globalThis.fetch

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data, error: null, message: 'OK' }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function failure(code: string, status: number): Response {
  return new Response(
    JSON.stringify({ success: false, data: null, error: { code, message: code }, message: code }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

beforeEach(() => {
  calls = []
  sessionEvents = 0
  reply = async () => envelope({})
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    return reply()
  }) as typeof fetch
  ;(globalThis as { window?: unknown }).window = {
    dispatchEvent: () => {
      sessionEvents += 1
      return true
    },
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { window?: unknown }).window
})

function headers(call: Call): Record<string, string> {
  return Object.fromEntries(new Headers(call.init.headers).entries())
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('envelope handling', () => {
  test('success returns data', async () => {
    reply = async () => envelope({ tickets: [], nextCursor: null, counts: {} })
    const result = await listEnquiries({ q: '', status: 'all', category: 'all', tag: '' })
    assert.deepEqual(result, { ok: true, data: { tickets: [], nextCursor: null, counts: {} } })
  })

  test('errors keep the HelpDesk code and status', async () => {
    reply = async () => failure('HELPDESK_NOT_CONNECTED', 503)
    assert.deepEqual(await getEnquiry('t1'), { ok: false, code: 'HELPDESK_NOT_CONNECTED', status: 503 })
  })

  test('network failure is HELPDESK_UNAVAILABLE', async () => {
    reply = async () => {
      throw new TypeError('offline')
    }
    assert.deepEqual(await getEnquiry('t1'), { ok: false, code: 'HELPDESK_UNAVAILABLE', status: 0 })
  })

  test('401 / 403 tell the shell to re-read the session', async () => {
    reply = async () => failure('NOT_AUTHORISED', 403)
    await getEnquiry('t1')
    assert.equal(sessionEvents, 1)
  })
})

describe('enquiries', () => {
  test('list builds the filter query', async () => {
    await listEnquiries({ q: 'login', status: 'needs_reply', category: 'all', tag: '' }, 'c2')
    assert.equal(calls[0].url, '/api/helpdesk/tickets?status=needs_reply&q=login&cursor=c2&limit=30')
    assert.equal(calls[0].init.credentials, 'same-origin')
  })

  test('detail encodes the id', async () => {
    await getEnquiry('a/b')
    assert.equal(calls[0].url, '/api/helpdesk/tickets/a%2Fb')
  })

  test('message: JSON body, Idempotency-Key header', async () => {
    await sendMessage('t1', { body: 'Hi', internal: true, expectedSequence: 4 }, 'key-1')
    const call = calls[0]
    assert.equal(call.url, '/api/helpdesk/tickets/t1/messages')
    assert.equal(call.init.method, 'POST')
    assert.equal(headers(call)['idempotency-key'], 'key-1')
    assert.equal(headers(call)['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(String(call.init.body)), { body: 'Hi', internal: true, expectedSequence: 4 })
  })

  test('actions: Mark as reviewed = propose_resolution; tags; mark_read without a sequence', async () => {
    await sendAction('t1', { action: 'propose_resolution', expectedSequence: 2 }, 'k1')
    await sendAction('t1', { action: 'add_tag', tag: 'vip', expectedSequence: 3 }, 'k2')
    await sendAction('t1', { action: 'remove_tag', tag: 'vip', expectedSequence: 4 }, 'k3')
    await sendAction('t1', { action: 'mark_read' }, 'k4')
    assert.deepEqual(
      calls.map((call) => [call.url, JSON.parse(String(call.init.body)), headers(call)['idempotency-key']]),
      [
        ['/api/helpdesk/tickets/t1/actions', { action: 'propose_resolution', expectedSequence: 2 }, 'k1'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'add_tag', tag: 'vip', expectedSequence: 3 }, 'k2'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'remove_tag', tag: 'vip', expectedSequence: 4 }, 'k3'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'mark_read' }, 'k4'],
      ],
    )
  })

  test('attachments go through the BackOffice proxy', () => {
    assert.equal(attachmentUrl('att 1'), '/api/helpdesk/attachments/att%201')
  })

  test('idempotency keys are random UUID v4 (the server only accepts UUIDs)', () => {
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    assert.match(a, UUID)
    assert.notEqual(a, b)
  })
})

describe('common questions', () => {
  test('list with filters', async () => {
    reply = async () => envelope({ questions: [] })
    const result = await listQuestions({ locale: 'en-GB', category: 'all', status: 'all', q: '' })
    assert.equal(calls[0].url, '/api/helpdesk/questions?locale=en-GB&status=all')
    assert.deepEqual(result, { ok: true, data: { questions: [] } })
  })

  test('one question by encoded id (reloaded after a version conflict)', async () => {
    reply = async () => envelope({ id: 'q 1', version: 4 })
    const result = await getQuestion('q 1')
    assert.equal(calls[0].url, '/api/helpdesk/questions/q%201')
    assert.equal(calls[0].init.method, undefined)
    assert.deepEqual(result, { ok: true, data: { id: 'q 1', version: 4 } })
  })

  test('create = POST, update = PUT with version', async () => {
    const body = {
      locale: 'en-GB' as const,
      category: 'other' as const,
      question: 'Q',
      answer: 'A',
      keywords: [],
      featured: false,
    }
    await createQuestion({ ...body, publish: true })
    await updateQuestion('q1', { ...body, version: 2 })
    assert.equal(calls[0].url, '/api/helpdesk/questions')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ...body, publish: true })
    assert.equal(calls[1].url, '/api/helpdesk/questions/q1')
    assert.equal(calls[1].init.method, 'PUT')
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { ...body, version: 2 })
  })

  test('publish / unpublish / archive carry the version', async () => {
    await transitionQuestion('q1', 'publish', 3)
    await transitionQuestion('q1', 'unpublish', 4)
    await transitionQuestion('q1', 'archive', 5)
    assert.deepEqual(
      calls.map((call) => [call.url, call.init.method, JSON.parse(String(call.init.body))]),
      [
        ['/api/helpdesk/questions/q1/publish', 'POST', { version: 3 }],
        ['/api/helpdesk/questions/q1/unpublish', 'POST', { version: 4 }],
        ['/api/helpdesk/questions/q1/archive', 'POST', { version: 5 }],
      ],
    )
  })

  test('reorder sends the whole order', async () => {
    await reorderQuestions([
      { id: 'a', version: 1 },
      { id: 'b', version: 2 },
    ])
    assert.equal(calls[0].url, '/api/helpdesk/questions/reorder')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      items: [
        { id: 'a', version: 1 },
        { id: 'b', version: 2 },
      ],
    })
  })

  test('VERSION_CONFLICT comes back as its own code', async () => {
    reply = async () => failure('VERSION_CONFLICT', 409)
    assert.deepEqual(await transitionQuestion('q1', 'publish', 1), {
      ok: false,
      code: 'VERSION_CONFLICT',
      status: 409,
    })
  })
})
