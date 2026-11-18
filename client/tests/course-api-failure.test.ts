import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { boRequest } from '../src/backoffice/lib/api'

const realFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ success: false, data: null, error: { code: 'COURSE_STALE', message: 'changed', details: { updatedByName: 'Wei' } } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('a failed request keeps the server code, details and status', async () => {
  const result = await boRequest('/api/backoffice/courses/c1/lessons/l1', { method: 'PUT' })
  assert.equal(result.success, false)
  if (result.success) return
  assert.equal(result.code, 'COURSE_STALE')
  assert.equal(result.status, 409)
  assert.deepEqual(result.details, { updatedByName: 'Wei' })
})
