import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { boRequest } from '../src/backoffice/lib/api'

const COURSE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
const OTHER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'

let calls: Array<{ url: string; headers: Headers }> = []
let etag: string | null = null
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  etag = null
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: new Headers(init.headers) })
    const headers = new Headers({ 'content-type': 'application/json' })
    if (etag) headers.set('etag', etag)
    return new Response(JSON.stringify({ success: true, data: {}, error: null }), { status: 200, headers })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('sends the revision it last read with every write to that course', async () => {
  etag = '"r4"'
  await boRequest(`/api/backoffice/courses/${COURSE}`)
  etag = '"r5"'
  await boRequest(`/api/backoffice/courses/${COURSE}/lessons/x`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  await boRequest(`/api/backoffice/courses/${COURSE}/publish`, { method: 'POST' })

  assert.equal(calls[0].headers.get('if-match'), null)
  assert.equal(calls[1].headers.get('if-match'), '"r4"')
  assert.equal(calls[1].headers.get('content-type'), 'application/json')
  assert.equal(calls[2].headers.get('if-match'), '"r5"')
})

test('ignores other courses and Express weak ETags', async () => {
  etag = '"r9"'
  await boRequest(`/api/backoffice/courses/${COURSE}`)
  etag = 'W/"9c-abc"'
  await boRequest(`/api/backoffice/courses/${COURSE}/trial`)
  await boRequest(`/api/backoffice/courses/${OTHER}/lessons`, { method: 'POST' })
  await boRequest(`/api/backoffice/courses/${COURSE}/lessons`, { method: 'POST' })

  assert.equal(calls[2].headers.get('if-match'), null)
  assert.equal(calls[3].headers.get('if-match'), '"r9"')
})
