import './support/dom'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fmtTimeInput, parseTimeInput } from '../src/backoffice/pages/course-editor/shared-utils';

describe('course time input', () => {
  test('parses mm:ss as minutes and seconds', () => {
    assert.equal(parseTimeInput('40:24'), 2424)
    assert.equal(parseTimeInput('3:15'), 195)
    assert.equal(parseTimeInput('03:15'), 195)
    assert.equal(parseTimeInput(' 3 : 15 '), 195)
    assert.equal(parseTimeInput('3：15'), 195)
  })

  test('parses h:mm:ss as hours, minutes and seconds', () => {
    assert.equal(parseTimeInput('1:02:03'), 3723)
  })

  test('treats bare numbers as seconds', () => {
    assert.equal(parseTimeInput('180'), 180)
    assert.equal(fmtTimeInput(parseTimeInput('180')), '3:00')
  })

  test('returns null for empty or invalid input', () => {
    assert.equal(parseTimeInput(''), null)
    assert.equal(parseTimeInput('   '), null)
    assert.equal(parseTimeInput('abc'), null)
    assert.equal(parseTimeInput('3:xx'), null)
  })

  test('formats seconds back to m:ss', () => {
    assert.equal(fmtTimeInput(null), '')
    assert.equal(fmtTimeInput(0), '0:00')
    assert.equal(fmtTimeInput(195), '3:15')
    assert.equal(fmtTimeInput(2424), '40:24')
    assert.equal(fmtTimeInput(3723), '62:03')
  })
})
