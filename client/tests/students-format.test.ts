import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { StudentActionEmail } from '../src/backoffice/contracts/students'
import { emailDelivery, formatStudentInterest } from '../src/backoffice/lib/studentsFormat'

describe('BUG-0357: Portal interest values are shown in the BackOffice language', () => {
  test('zh-CN translates every Portal interest label', () => {
    const expected: Record<string, string> = {
      Humanities: '人文',
      Science: '科学',
      History: '历史',
      Philosophy: '哲学',
      Mathematics: '数学',
      Literature: '文学',
      Arts: '艺术',
    }
    for (const [value, label] of Object.entries(expected)) {
      assert.equal(formatStudentInterest('zh-CN', value), label, value)
    }
  })

  test('en-GB keeps the Portal value as-is', () => {
    assert.equal(formatStudentInterest('en-GB', 'Humanities'), 'Humanities')
    assert.equal(formatStudentInterest('en-GB', 'Computer Science'), 'Computer Science')
  })

  test('an unknown or differently-cased value falls back to the stored value', () => {
    assert.equal(formatStudentInterest('zh-CN', 'Computer Science'), 'Computer Science')
    assert.equal(formatStudentInterest('zh-CN', 'humanities'), 'humanities')
    assert.equal(formatStudentInterest('zh-CN', ''), '')
  })
})

describe('BUG-0358/0359: Portal email delivery states', () => {
  const cases: Array<[StudentActionEmail | null, ReturnType<typeof emailDelivery>]> = [
    [null, null],
    [{ sent: true }, 'sent'],
    [{ sent: false }, 'unsent'],
    [{ sent: null, pending: true }, 'pending'],
  ]
  for (const [email, expected] of cases) {
    test(`${JSON.stringify(email)} -> ${expected}`, () => {
      assert.equal(emailDelivery(email), expected)
    })
  }
})
