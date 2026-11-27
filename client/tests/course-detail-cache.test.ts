import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boRequest, rememberCourseRevision } from '../src/backoffice/lib/api.ts'

test('course detail is fetched fresh while draft ETag remains available for writes', async () => {
  const original = globalThis.fetch
  const calls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    calls.push(init ?? {})
    return new Response(JSON.stringify({ success: true, data: {}, error: null }), { headers: { 'content-type': 'application/json', etag: '"r7"' } })
  }
  try {
    const url = '/api/backoffice/courses/11111111-1111-4111-8111-111111111111'
    rememberCourseRevision(url, '"r7"')
    await boRequest(url)
    await boRequest(url, { method: 'PUT' })
    assert.equal(calls[0].cache, 'no-store')
    assert.equal(new Headers(calls[1].headers).get('if-match'), '"r7"')
    assert.notEqual(calls[1].cache, 'no-store')
  } finally {
    globalThis.fetch = original
  }
})
