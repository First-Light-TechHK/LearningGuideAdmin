import './support/dom'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { HistoryItem } from '../src/backoffice/contracts/course'
import { historyActionLabel, historyDetailText } from '../src/backoffice/pages/course-editor/versionHistory';

function item(action: string, detail: unknown, versionNo: number | null = null): HistoryItem {
  return {
    id: 'h1',
    time: '2026-10-20T10:00:00.000Z',
    operator: 'Jack',
    action,
    versionNo,
    detail,
  }
}

describe('course editor history formatting', () => {
  test('formats publish details with source and learner notification', () => {
    const text = historyDetailText(
      item('PUBLISH', { versionLabel: 'Version 4', sourceEnvironment: 'UAT', sourceVersionLabel: 'Version 3', notifyLearners: true }),
      'en-GB',
    )
    assert.equal(text, 'Version 4 · from UAT Version 3 · learners notified')
  })

  test('formats status changes with reason', () => {
    const text = historyDetailText(item('CHANGE_STATUS', { from: 'ONLINE', to: 'HIDDEN', reason: 'Reviewing materials' }), 'en-GB')
    assert.equal(text, 'ONLINE → HIDDEN · Reviewing materials')
  })

  test('formats restore and delete draft details', () => {
    assert.equal(historyDetailText(item('RESTORE', { restoredFrom: 'Version 2' }), 'zh-CN'), '从 版本 2 恢复')
    assert.equal(historyDetailText(item('DELETE_DRAFT', { keptVersion: 'Version 4' }), 'en-GB'), 'Kept Version 4')
  })

  test('shows the one version name and never the internal sequence number', () => {
    assert.equal(historyDetailText(item('PUBLISH', { versionLabel: '4.2' }, 9), 'en-GB'), 'Version 4.2')
    assert.equal(historyDetailText(item('EXPORT_PACKAGE', { versionLabel: 'V4.2' }, 9), 'en-GB').includes('9'), false)
    assert.equal(historyDetailText(item('PUBLISH', null, 9), 'en-GB'), '—')
  })

  test('writes the created course in plain words', () => {
    assert.equal(
      historyDetailText(item('CREATE_COURSE', { courseCode: 'C001', learningMode: 'VIDEO_AND_TEXT', learningLanguages: ['en-GB', 'zh-CN'] }), 'en-GB'),
      'C001 · Video & text · English / Chinese',
    )
  })

  test('falls back to readable key/value pairs for unknown details', () => {
    assert.equal(historyDetailText(item('UNKNOWN', { foo: 'bar', empty: null }), 'en-GB'), 'foo: bar · empty: —')
  })

  test('localizes known action labels', () => {
    assert.equal(historyActionLabel('PUBLISH', 'en-GB'), 'Publish')
    assert.equal(historyActionLabel('CHANGE_STATUS', 'zh-CN'), '更改状态')
    assert.equal(historyActionLabel('CUSTOM_ACTION', 'en-GB'), 'CUSTOM_ACTION')
  })
})
