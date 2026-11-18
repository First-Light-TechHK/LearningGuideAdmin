import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { courseErrorText, courseFailureNotice, failureNeedsReload, isStale, rowFailure } from '../src/backoffice/lib/courseErrors'

const fail = (code: string, details: Record<string, unknown> = {}, message = 'An English sentence from the server') =>
  ({ error: code, code, message, details, status: 409 }) as Parameters<typeof courseErrorText>[1]

describe('course errors read the code and details, never the server sentence', () => {
  test('COURSE_STALE names who saved, in both languages', () => {
    const stale = fail('COURSE_STALE', { updatedByName: 'Wei Chen' })
    assert.match(courseErrorText('en-GB', stale), /Wei Chen/)
    assert.match(courseErrorText('zh-CN', stale), /Wei Chen/)
    assert.doesNotMatch(courseErrorText('zh-CN', stale), /English sentence/)
    assert.equal(isStale(stale), true)
  })

  test('COURSE_STALE without a name still reads as a sentence', () => {
    const text = courseErrorText('en-GB', fail('COURSE_STALE'))
    assert.ok(text.length > 10)
    assert.doesNotMatch(text, /undefined|\{name\}/)
  })

  test('INVALID_TIME carries the 1-based row', () => {
    const invalid = fail('INVALID_TIME', { row: 3 })
    assert.match(courseErrorText('en-GB', invalid), /3/)
    assert.match(courseErrorText('zh-CN', invalid), /3/)
    const placed = rowFailure('en-GB', invalid)
    assert.equal(placed?.row, 3)
    assert.equal(placed?.code, 'INVALID_TIME')
  })

  test('INVALID_TIME without a row has its own sentence and no row placement', () => {
    const invalid = fail('INVALID_TIME')
    assert.doesNotMatch(courseErrorText('en-GB', invalid), /undefined|\{row\}/)
    assert.equal(rowFailure('en-GB', invalid), null)
  })

  test('EXHIBIT_IN_USE lists where the exhibit is used', () => {
    const inUse = fail('EXHIBIT_IN_USE', { usages: [{ kind: 'VIDEO', language: 'en-GB', position: '2.1' }, { kind: 'TEXT', language: 'en-GB', position: '2.3' }] })
    const en = courseErrorText('en-GB', inUse)
    assert.match(en, /2\.1/)
    assert.match(en, /2\.3/)
    const zh = courseErrorText('zh-CN', inUse)
    assert.match(zh, /2\.1/)
    assert.match(zh, /2\.3/)
  })

  test('READING_COLUMNS_INVALID names the missing columns', () => {
    const invalid = fail('READING_COLUMNS_INVALID', { missing: ['Lesson ID', 'Type'] })
    assert.match(courseErrorText('en-GB', invalid), /Lesson ID, Type/)
    assert.match(courseErrorText('zh-CN', invalid), /Lesson ID, Type/)
  })

  test('PUBLISH_BLOCKED, LESSON_ID_IMMUTABLE and LESSON_ORDER_INCOMPLETE have local sentences', () => {
    for (const code of ['PUBLISH_BLOCKED', 'LESSON_ID_IMMUTABLE']) {
      assert.doesNotMatch(courseErrorText('zh-CN', fail(code)), /English sentence/)
      assert.doesNotMatch(courseErrorText('en-GB', fail(code)), /English sentence/)
    }
    const order = courseErrorText('en-GB', fail('LESSON_ORDER_INCOMPLETE', { expected: 3, received: 2 }))
    assert.match(order, /3/)
    assert.match(order, /2/)
  })

  test('an unknown code falls back to a generic sentence, not the server message', () => {
    const text = courseErrorText('zh-CN', fail('SOMETHING_NEW'))
    assert.doesNotMatch(text, /English sentence/)
    assert.ok(text.length > 0)
  })

  test('a notice reads "action: reason"; missing-lesson codes ask for a reload', () => {
    assert.match(courseFailureNotice('en-GB', 'Save failed', fail('COURSE_STALE', { updatedByName: 'Ann' })), /^Save failed: .*Ann/)
    assert.equal(failureNeedsReload(fail('LESSON_NOT_FOUND')), true)
    assert.equal(failureNeedsReload(fail('INVALID_TIME', { row: 1 })), false)
  })
})
