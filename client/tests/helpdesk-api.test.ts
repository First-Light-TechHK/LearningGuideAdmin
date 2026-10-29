import test, { afterEach, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  archiveFaq,
  attachmentUrl,
  createFaq,
  getEnquiry,
  getFaq,
  listEnquiries,
  listFaqs,
  listTimeline,
  newIdempotencyKey,
  sendAction,
  sendMessage,
  updateFaq,
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
    await listEnquiries({ q: 'login', status: 'needs_reply', category: 'all', tag: '', flagged: false }, 'c2')
    assert.equal(calls[0].url, '/api/helpdesk/tickets?status=needs_reply&q=login&cursor=c2&limit=30')
    assert.equal(calls[0].init.credentials, 'same-origin')
  })

  test('the Flagged filter sends flagged=true (v2)', async () => {
    await listEnquiries({ q: '', status: 'all', category: 'all', tag: '', flagged: true })
    assert.equal(calls[0].url, '/api/helpdesk/tickets?flagged=true&limit=30')
  })

  test('the student timeline asks for that learner, 10 at most (v2)', async () => {
    await listTimeline('user 1')
    assert.equal(calls[0].url, '/api/helpdesk/tickets?learnerId=user+1&limit=10')
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
    await sendAction('t1', { action: 'flag', expectedSequence: 5 }, 'k5')
    await sendAction('t1', { action: 'unflag', expectedSequence: 6 }, 'k6')
    assert.deepEqual(
      calls.map((call) => [call.url, JSON.parse(String(call.init.body)), headers(call)['idempotency-key']]),
      [
        ['/api/helpdesk/tickets/t1/actions', { action: 'propose_resolution', expectedSequence: 2 }, 'k1'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'add_tag', tag: 'vip', expectedSequence: 3 }, 'k2'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'remove_tag', tag: 'vip', expectedSequence: 4 }, 'k3'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'mark_read' }, 'k4'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'flag', expectedSequence: 5 }, 'k5'],
        ['/api/helpdesk/tickets/t1/actions', { action: 'unflag', expectedSequence: 6 }, 'k6'],
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

describe('FAQs (Tickets v2 §3)', () => {
  const body = {
    category: 'other' as const,
    popular: true,
    questionEn: 'Q',
    answerEn: 'A',
    questionZh: '问',
    answerZh: '答',
    keywords: ['k'],
  }

  test('list with the URL filters', async () => {
    reply = async () => envelope({ faqs: [], total: 0, page: 2, pageSize: 10 })
    const result = await listFaqs({ q: 'reset', category: 'other', popular: 'popular', page: 2 })
    assert.equal(calls[0].url, '/api/helpdesk/faqs?category=other&popular=true&q=reset&page=2&pageSize=10')
    assert.deepEqual(result, { ok: true, data: { faqs: [], total: 0, page: 2, pageSize: 10 } })
  })

  test('one FAQ by encoded id (reloaded after a version conflict)', async () => {
    reply = async () => envelope({ id: 'f 1', version: 4 })
    await getFaq('f 1')
    assert.equal(calls[0].url, '/api/helpdesk/faqs/f%201')
    assert.equal(calls[0].init.method, undefined)
  })

  test('create = POST with Idempotency-Key, update = PUT with version, delete = archive with version', async () => {
    await createFaq(body, 'key-1')
    await updateFaq('f1', { ...body, version: 2 })
    await archiveFaq('f1', 3)
    assert.deepEqual(
      calls.map((call) => [call.url, call.init.method, JSON.parse(String(call.init.body)), headers(call)['idempotency-key']]),
      [
        ['/api/helpdesk/faqs', 'POST', body, 'key-1'],
        ['/api/helpdesk/faqs/f1', 'PUT', { ...body, version: 2 }, undefined],
        ['/api/helpdesk/faqs/f1/archive', 'POST', { version: 3 }, undefined],
      ],
    )
  })

  test('VERSION_CONFLICT comes back as its own code', async () => {
    reply = async () => failure('VERSION_CONFLICT', 409)
    assert.deepEqual(await updateFaq('f1', { ...body, version: 1 }), {
      ok: false,
      code: 'VERSION_CONFLICT',
      status: 409,
    })
  })
})
