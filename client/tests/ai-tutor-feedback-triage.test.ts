import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { feedbackSource } from '../src/api/feedback'
import { blankTriage, loadTriage, saveTriage, transitionTriage, type TriageDraft } from '../src/api/feedbackTriage'

afterEach(() => localStorage.clear())
const record = () => feedbackSource.list()[0]
const classified: TriageDraft = { ...blankTriage, issue: 'Knowledge gap', outcome: 'Classified only', note: 'Investigate lesson example' }
const corrected: TriageDraft = { ...classified, outcome: 'Knowledge updated', change: 'Release demo-r2 / Page state-space', verification: 'Expert Demo checked regression example' }
const time1 = '2026-11-13T01:00:00Z'
const time2 = '2026-11-13T02:00:00Z'
const storageKey = (owner: string) => `aitutor.feedback.v1.${encodeURIComponent(owner)}`

test('classification requires valid issue and outcome and does not close a record', () => {
  for (const draft of [blankTriage, { ...classified, issue: 'unknown' }, { ...classified, outcome: '' }]) {
    assert.throws(() => transitionTriage(record(), undefined, draft, 'Triaged', 'expert', time1), /required/)
  }
  const result = transitionTriage(record(), undefined, classified, 'Triaged', 'expert', time1)
  assert.equal(result.resolvedAt, null)
  assert.equal(result.history.length, 1)
  assert.deepEqual(result.history[0], { at: time1, actor: 'expert', from: 'New', to: 'Triaged', draft: classified })
  assert.equal(record().status, 'New')
})

test('Applied requires prior triage, an actual knowledge or prompt change and verification', () => {
  assert.throws(() => transitionTriage(record(), undefined, corrected, 'Applied', 'expert', time1), /transition/)
  const previous = transitionTriage(record(), undefined, classified, 'Triaged', 'expert', time1)
  for (const draft of [{ ...corrected, change: ' ' }, { ...corrected, verification: '' }, { ...corrected, outcome: 'AI technical review' }, classified]) {
    assert.throws(() => transitionTriage(record(), previous, draft, 'Applied', 'expert', time2), /evidence/)
  }
  for (const outcome of ['Knowledge updated', 'Prompt updated']) {
    const result = transitionTriage(record(), previous, { ...corrected, outcome }, 'Applied', 'reviewer', time2)
    assert.equal(result.status, 'Applied')
    assert.equal(result.resolvedAt, time2)
    assert.equal(result.history.length, 2)
    assert.equal(previous.history.length, 1)
  }
})

test('dismissal requires a reason and No action needed; reopening clears closure and preserves history', () => {
  assert.throws(() => transitionTriage(record(), undefined, classified, 'Dismissed', 'expert', time1), /reason/)
  assert.throws(() => transitionTriage(record(), undefined, { ...classified, outcome: 'No action needed', note: ' ' }, 'Dismissed', 'expert', time1), /reason/)
  const dismissed = transitionTriage(record(), undefined, { ...classified, outcome: 'No action needed', note: 'Positive feedback' }, 'Dismissed', 'expert', time1)
  assert.equal(dismissed.resolvedAt, time1)
  assert.throws(() => transitionTriage(record(), dismissed, { ...classified, note: '' }, 'Triaged', 'expert', time2), /reason/)
  const reopened = transitionTriage(record(), dismissed, { ...classified, note: 'Additional evidence received' }, 'Triaged', 'reviewer', time2)
  assert.equal(reopened.resolvedAt, null)
  assert.equal(reopened.history.length, 2)
  assert.equal(reopened.history[0].to, 'Dismissed')
  assert.equal(reopened.history[1].actor, 'reviewer')
})

test('closed records cannot be silently rewritten or moved to New', () => {
  const previous = transitionTriage(record(), undefined, classified, 'Triaged', 'expert', time1)
  const applied = transitionTriage(record(), previous, corrected, 'Applied', 'expert', time2)
  for (const target of ['New', 'Applied', 'Dismissed'] as const) {
    assert.throws(() => transitionTriage(record(), applied, corrected, target, 'expert', time2), /transition/)
  }
  assert.throws(() => transitionTriage(record(), previous, classified, 'New', 'expert', time2), /transition/)
  assert.throws(() => transitionTriage(record(), previous, { ...classified, outcome: 'No action needed' }, 'Triaged', 'expert', time2), /transition/)
})

test('trimmed values are recorded without mutating the caller draft', () => {
  const draft = { ...classified, note: '  Keep original learner feedback  ' }
  const result = transitionTriage(record(), undefined, draft, 'Triaged', 'expert', time1)
  assert.equal(result.note, 'Keep original learner feedback')
  assert.equal(result.history[0].draft.note, result.note)
  assert.equal(draft.note, '  Keep original learner feedback  ')
})

test('versioned storage round-trips history and isolates employee keys', () => {
  assert.deepEqual(loadTriage('employee-one'), {})
  const triage = transitionTriage(record(), undefined, classified, 'Triaged', 'employee-one', time1)
  saveTriage('employee-one', { 'DEMO-001': triage })
  assert.deepEqual(loadTriage('employee-one'), { 'DEMO-001': triage })
  assert.deepEqual(loadTriage('employee-two'), {})
  assert.equal(JSON.parse(localStorage.getItem(storageKey('employee-one'))!).version, 1)
  saveTriage('employee/a', { 'DEMO-001': triage })
  assert.ok(localStorage.getItem(storageKey('employee/a')))
  assert.deepEqual(loadTriage('employee%2Fa'), {})
})

test('malformed data and unknown versions fail without replacing the original stored bytes', () => {
  for (const raw of ['', '{broken', 'null', JSON.stringify({ version: 2, records: {} }), JSON.stringify({ version: 1, records: [] }), JSON.stringify({ version: 1, records: { bad: {} } })]) {
    localStorage.setItem(storageKey('damaged'), raw)
    assert.throws(() => loadTriage('damaged'))
    assert.equal(localStorage.getItem(storageKey('damaged')), raw)
  }
})

test('invalid history and closure timestamps are rejected without data loss', () => {
  const state = transitionTriage(record(), undefined, classified, 'Triaged', 'expert', time1)
  for (const changed of [{ ...state, resolvedAt: 'not-a-date' }, { ...state, history: [] }, { ...state, history: [{}] }, { ...state, issue: 'unknown' }, { ...state, status: 'Applied', resolvedAt: null }, { ...state, history: [{ ...state.history[0], draft: {} }] }]) {
    const raw = JSON.stringify({ version: 1, records: { 'DEMO-001': changed } })
    localStorage.setItem(storageKey('damaged'), raw)
    assert.throws(() => loadTriage('damaged'), /storage/)
    assert.equal(localStorage.getItem(storageKey('damaged')), raw)
  }
})

test('storage access and quota failures propagate and leave the existing snapshot intact', () => {
  const state = transitionTriage(record(), undefined, classified, 'Triaged', 'expert', time1)
  saveTriage('employee', { 'DEMO-001': state })
  const raw = localStorage.getItem(storageKey('employee'))
  const prototype = Object.getPrototypeOf(localStorage)
  const originalSet = prototype.setItem
  const originalGet = prototype.getItem
  try {
    prototype.setItem = () => { throw new Error('QuotaExceededError') }
    assert.throws(() => saveTriage('employee', {}), /QuotaExceededError/)
    assert.equal(localStorage.getItem(storageKey('employee')), raw)
    prototype.getItem = () => { throw new Error('SecurityError') }
    assert.throws(() => loadTriage('employee'), /SecurityError/)
  } finally {
    prototype.setItem = originalSet
    prototype.getItem = originalGet
  }
})
