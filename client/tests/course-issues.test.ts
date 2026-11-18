import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { hasIssue, issueLine, issuesAt } from '../src/backoffice/lib/courseIssues'
import type { CourseIssue } from '../src/backoffice/contracts/course'
import { parseTextLearningPoints } from '../src/backoffice/pages/course-editor/CourseContentSection'

const issue = (over: Partial<CourseIssue>): CourseIssue =>
  ({ step: 'COURSE_INFORMATION', code: 'REQUIRED', message: 'Required', field: 'title', lessonId: null, language: null, ...over }) as CourseIssue

describe('server issues are placed by field path', () => {
  const issues = [
    issue({ language: 'en-GB' }),
    issue({ language: 'zh-CN' }),
    issue({ step: 'COURSE_CONTENT', lessonId: 'L1', language: 'en-GB' }),
    issue({ field: 'category' }),
  ]

  test('the step keeps Course Information and lesson fields called title apart', () => {
    assert.equal(issuesAt(issues, { step: 'COURSE_INFORMATION', field: 'title' }).length, 2)
    assert.equal(issuesAt(issues, { step: 'COURSE_CONTENT', lessonId: 'L1', field: 'title' }).length, 1)
  })

  test('language null means only the ones with no language', () => {
    assert.equal(issuesAt(issues, { field: 'category', language: null }).length, 1)
    assert.equal(issuesAt(issues, { field: 'title', language: null }).length, 0)
    assert.equal(hasIssue(issues, { field: 'title', language: 'zh-CN' }), true)
  })

  test('no issues give no line', () => {
    assert.equal(issueLine('en-GB', undefined, { field: 'title' }), null)
    assert.equal(issueLine('en-GB', [], { field: 'title' }), null)
  })

  test('a line is written in the current language, never the server sentence', () => {
    const line = issueLine('zh-CN', [issue({ code: 'REQUIRED', message: 'Required' })], { field: 'title' })
    assert.ok(line && line.length > 0)
    assert.doesNotMatch(line, /Required/)
  })
})

describe('text learning points', () => {
  test('headings are listed with the code the server stamped on them', () => {
    const points = parseTextLearningPoints('<h1 data-lp="T1">First</h1><p>x</p><h1>Second <b>one</b></h1><h2>skip</h2>')
    assert.deepEqual(points, [
      { heading: 'First', code: 'T1' },
      { heading: 'Second one', code: null },
    ])
  })
})
