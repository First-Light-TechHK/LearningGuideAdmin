import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { courseErrorText, courseFailureNotice, failureNeedsReload, isStale, rowFailure } from '../src/backoffice/lib/courseErrors'
import { t } from '../src/backoffice/lib/i18n/messages'

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

  test('COURSE_STALE without a name reads as the unknown-person sentence', () => {
    for (const locale of ['en-GB', 'zh-CN'] as const) {
      assert.equal(courseErrorText(locale, fail('COURSE_STALE')), t(locale, 'course.errors.COURSE_STALE_UNKNOWN'))
      assert.equal(courseErrorText(locale, fail('COURSE_STALE', { updatedByName: '  ' })), t(locale, 'course.errors.COURSE_STALE_UNKNOWN'))
    }
  })

  test('INVALID_TIME carries the 1-based row', () => {
    const invalid = fail('INVALID_TIME', { row: 7 })
    assert.match(courseErrorText('en-GB', invalid), /Row 7/)
    assert.match(courseErrorText('zh-CN', invalid), /第 7 行/)
    const placed = rowFailure('en-GB', invalid)
    assert.equal(placed?.row, 7)
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
    for (const locale of ['en-GB', 'zh-CN'] as const) {
      for (const code of ['PUBLISH_BLOCKED', 'LESSON_ID_IMMUTABLE', 'REASON_REQUIRED', 'TRIAL_NOT_CONTIGUOUS', 'DOCX_INVALID', 'FILE_REQUIRED', 'VIDEO_REQUIRED']) {
        const expected = t(locale, `course.errors.${code}`)
        assert.notEqual(expected, `course.errors.${code}`, `${code} has a ${locale} sentence`)
        assert.equal(courseErrorText(locale, fail(code)), expected)
      }
    }
    const order = courseErrorText('en-GB', fail('LESSON_ORDER_INCOMPLETE', { expected: 3, received: 2 }))
    assert.equal(order, t('en-GB', 'course.errors.LESSON_ORDER_INCOMPLETE', { expected: '3', received: '2' }))
  })

  test('a code without a local sentence shows the server sentence passed through (English page)', () => {
    assert.equal(courseErrorText('en-GB', fail('SOMETHING_NEW')), 'An English sentence from the server')
  })

  test('a code without a local sentence and without a message falls back to the generic line', () => {
    const bare = { error: 'SOMETHING_NEW', code: 'SOMETHING_NEW', status: 400 } as Parameters<typeof courseErrorText>[1]
    assert.equal(courseErrorText('en-GB', bare), t('en-GB', 'errors.serverGeneric'))
    assert.equal(courseErrorText('zh-CN', bare), t('zh-CN', 'errors.serverGeneric'))
  })

  test('codes whose server sentence names the place (REQUIRED, TRIAL_CUTOFF_INVALID, VERSION_INCOMPLETE) show it in English and the local line in Chinese', () => {
    for (const code of ['REQUIRED', 'TRIAL_CUTOFF_INVALID', 'VERSION_INCOMPLETE']) {
      assert.equal(courseErrorText('en-GB', fail(code, {}, 'Question 1 is required.')), 'Question 1 is required.')
      // The request layer has already turned an English sentence into the generic line on a Chinese page.
      assert.equal(courseErrorText('zh-CN', fail(code, {}, t('zh-CN', 'errors.serverGeneric'))), t('zh-CN', `course.errors.${code}`))
    }
  })

  test('a sign-in style code keeps its own sentence', () => {
    assert.equal(courseErrorText('en-GB', fail('NOT_AUTHORISED')), t('en-GB', 'errors.NOT_AUTHORISED'))
  })

  test('a notice reads "action: reason"; missing-lesson codes ask for a reload', () => {
    assert.match(courseFailureNotice('en-GB', 'Save failed', fail('COURSE_STALE', { updatedByName: 'Ann' })), /^Save failed: .*Ann/)
    assert.equal(failureNeedsReload(fail('LESSON_NOT_FOUND')), true)
    assert.equal(failureNeedsReload(fail('INVALID_TIME', { row: 1 })), false)
  })
})
