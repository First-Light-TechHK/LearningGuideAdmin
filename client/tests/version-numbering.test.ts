import assert from 'node:assert/strict'
import { test } from 'node:test'

import { latestVersion, nextVersionLabel, versionName } from '../src/backoffice/pages/course-editor/versionNumbering'

test('nextVersionLabel mirrors the server rule', () => {
  assert.equal(nextVersionLabel('production', null), 'Version 1')
  assert.equal(nextVersionLabel('production', { versionSeries: 1, versionMinor: 4 }), 'Version 5')
  assert.equal(nextVersionLabel('sandbox', null), '1.1')
  assert.equal(nextVersionLabel('sandbox', { versionSeries: 4, versionMinor: 2 }), '4.3')
  assert.equal(nextVersionLabel('sandbox', { versionSeries: 4, versionMinor: 2, exportedAt: '2026-01-01' }), '5.1')
})

test('latestVersion picks the highest versionNo', () => {
  assert.equal(latestVersion([]), null)
  const list = [{ versionNo: 2 }, { versionNo: 9 }, { versionNo: 5 }] as never
  assert.equal((latestVersion(list) as { versionNo: number }).versionNo, 9)
})

test('versionName strips a leading Version and localizes', () => {
  assert.equal(versionName('en-GB', '4.2'), 'Version 4.2')
  assert.equal(versionName('en-GB', 'Version 4'), 'Version 4')
  assert.equal(versionName('zh-CN', '4.2'), '版本 4.2')
  assert.equal(versionName('zh-CN', 'Version 4'), '版本 4')
})
