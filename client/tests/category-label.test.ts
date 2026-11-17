import test from 'node:test'
import assert from 'node:assert/strict'

import { categoryLabel } from '../src/backoffice/lib/categoryLabel'

test('shows every preset course category in Chinese', () => {
  assert.equal(categoryLabel('zh-CN', 'Science'), '科学')
  assert.equal(categoryLabel('zh-CN', 'Chinese Humanities'), '中国人文')
  assert.equal(categoryLabel('zh-CN', 'European Humanities'), '欧洲人文')
  assert.equal(categoryLabel('zh-CN', 'Society'), '社会')
  assert.equal(categoryLabel('en-GB', 'Society'), 'Society')
})
