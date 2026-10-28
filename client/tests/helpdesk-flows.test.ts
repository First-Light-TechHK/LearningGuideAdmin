import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  afterQuestionSave,
  questionSaveFailure,
} from '../src/backoffice/lib/helpdeskQuestions'
import {
  clearBusy,
  composerKey,
  helpDeskPageControls,
  isImeComposing,
  markReadOnOpen,
  resyncQuery,
  settlePlan,
  visibleBusy,
} from '../src/backoffice/lib/helpdeskView'

/**
 * Decision logic the HelpDesk components run (no DOM: the client tests are node:test on
 * plain .ts, there is no jsdom / testing-library). Each function here is what one component
 * calls at that point, so these tests lock the behaviour, not just a helper.
 */

const AVAILABLE = { claim: true, reply: true, internalNote: true, proposeResolution: true, tag: true, markRead: true }

describe('write responses only touch the enquiry they were sent for (EnquiriesView.settle)', () => {
  const detail = { id: 'A', sequence: 3 }

  test('success on the open enquiry: update the row and the open ticket, clear the notice', () => {
    assert.deepEqual(settlePlan({ ok: true, data: detail }, 'A', 'A'), {
      ok: true,
      row: detail,
      adoptTicket: true,
      reload: false,
      notice: 'clear',
    })
  })

  test('success after the agent switched to B: update A\'s row only, never show A in B\'s place', () => {
    assert.deepEqual(settlePlan({ ok: true, data: detail }, 'A', 'B'), {
      ok: false,
      row: detail,
      adoptTicket: false,
      reload: false,
      notice: null,
    })
    assert.equal(settlePlan({ ok: true, data: detail }, 'A', null).adoptTicket, false)
  })

  test('409 STALE_TICKET on the open enquiry reloads it and says so', () => {
    assert.deepEqual(settlePlan({ ok: false, code: 'STALE_TICKET', status: 409 }, 'A', 'A'), {
      ok: false,
      row: null,
      adoptTicket: false,
      reload: true,
      notice: 'stale',
    })
  })

  test('409 STALE_TICKET or any error for an enquiry no longer open is dropped (no reload, no notice on B)', () => {
    for (const code of ['STALE_TICKET', 'INVALID_TRANSITION', 'HELPDESK_UNAVAILABLE']) {
      assert.deepEqual(settlePlan({ ok: false, code, status: 409 }, 'A', 'B'), {
        ok: false,
        row: null,
        adoptTicket: false,
        reload: false,
        notice: null,
      })
    }
  })

  test('other errors on the open enquiry are shown once', () => {
    assert.deepEqual(settlePlan({ ok: false, code: 'INVALID_TRANSITION', status: 409 }, 'A', 'A'), {
      ok: false,
      row: null,
      adoptTicket: false,
      reload: false,
      notice: 'error',
    })
  })
})

describe('busy state belongs to one enquiry', () => {
  test('a request still running for A does not disable B', () => {
    assert.equal(visibleBusy({ label: 'send', ticketId: 'A' }, 'A'), 'send')
    assert.equal(visibleBusy({ label: 'send', ticketId: 'A' }, 'B'), null)
    assert.equal(visibleBusy(null, 'A'), null)
  })

  test('a late finish of A does not clear B\'s busy flag', () => {
    const b = { label: 'claim', ticketId: 'B' }
    assert.equal(clearBusy(b, { label: 'send', ticketId: 'A' }), b)
    assert.equal(clearBusy(b, b), null)
    assert.equal(clearBusy(null, b), null)
  })
})

describe('composer Idempotency-Key (EnquiryConversation)', () => {
  let n = 0
  const make = () => `key-${++n}`

  test('an unchanged retry reuses the key', () => {
    const first = composerKey(null, 'Hello', false, make)
    assert.equal(composerKey(first, 'Hello', false, make), first)
  })

  test('changing the text, or switching reply / internal note, gets a new key', () => {
    const first = composerKey(null, 'Hello', false, make)
    const edited = composerKey(first, 'Hello!', false, make)
    assert.notEqual(edited.key, first.key)
    assert.deepEqual({ body: edited.body, internal: edited.internal }, { body: 'Hello!', internal: false })
    const note = composerKey(edited, 'Hello!', true, make)
    assert.notEqual(note.key, edited.key)
    assert.equal(note.internal, true)
  })

  test('the very first submit gets a fresh key', () => {
    const first = composerKey(null, 'Hi', true, () => 'fresh')
    assert.deepEqual(first, { key: 'fresh', body: 'Hi', internal: true })
  })
})

describe('mark_read when an enquiry is opened (EnquiriesView)', () => {
  test('FULL with unread: mark_read with the sequence the agent saw', () => {
    assert.deepEqual(markReadOnOpen({ sequence: 9, unreadByAgent: true, available: AVAILABLE }, true), {
      action: 'mark_read',
      expectedSequence: 9,
    })
  })

  test('VIEW, nothing unread, or not allowed: no call', () => {
    assert.equal(markReadOnOpen({ sequence: 9, unreadByAgent: true, available: AVAILABLE }, false), null)
    assert.equal(markReadOnOpen({ sequence: 9, unreadByAgent: false, available: AVAILABLE }, true), null)
    assert.equal(
      markReadOnOpen({ sequence: 9, unreadByAgent: true, available: { ...AVAILABLE, markRead: false } }, true),
      null,
    )
  })
})

describe('page header (HelpDeskPage): VIEW sees no write control', () => {
  test('FULL gets + Add Question and the modal; VIEW gets neither', () => {
    assert.deepEqual(helpDeskPageControls(true), { addQuestion: true, questionModal: true })
    assert.deepEqual(helpDeskPageControls(false), { addQuestion: false, questionModal: false })
  })
})

describe('search box follows the address bar (EnquiriesView)', () => {
  test('back / sidebar navigation to /help-desk clears a stale search box', () => {
    assert.equal(resyncQuery('refund', '', false), '')
    assert.equal(resyncQuery('old', 'new', false), 'new')
  })

  test('keeps what the agent is typing (pending debounce, or the same search with extra spaces)', () => {
    assert.equal(resyncQuery('refu', '', true), 'refu')
    assert.equal(resyncQuery('refund ', 'refund', false), 'refund ')
    assert.equal(resyncQuery('  refund', 'refund', false), '  refund')
  })
})

describe('IME: Enter while composing never submits', () => {
  test('isComposing or keyCode 229 means the IME owns the key', () => {
    assert.equal(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true } }), true)
    assert.equal(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false } }), true)
    assert.equal(isImeComposing({ keyCode: 229, nativeEvent: {} }), true)
    assert.equal(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } }), false)
  })
})

describe('Common Questions modal save failures (QuestionModal)', () => {
  test('VERSION_CONFLICT while editing: reload the latest version, keep the draft', () => {
    assert.equal(questionSaveFailure('VERSION_CONFLICT', true), 'reload')
  })

  test('QUESTION_NOT_FOUND while editing: close the modal', () => {
    assert.equal(questionSaveFailure('QUESTION_NOT_FOUND', true), 'close')
  })

  test('anything else is shown in the modal', () => {
    for (const code of ['INVALID_INPUT', 'INVALID_TRANSITION', 'HELPDESK_UNAVAILABLE']) {
      assert.equal(questionSaveFailure(code, true), 'show')
      assert.equal(questionSaveFailure(code, false), 'show')
    }
    assert.equal(questionSaveFailure('VERSION_CONFLICT', false), 'show')
  })

  test('the page: saved -> toast, close, refresh; conflict -> refresh, keep open; gone -> refresh, close, error', () => {
    assert.deepEqual(afterQuestionSave('saved'), { refresh: true, close: true, toast: 'saved' })
    assert.deepEqual(afterQuestionSave('conflict'), { refresh: true, close: false, toast: null })
    assert.deepEqual(afterQuestionSave('gone'), { refresh: true, close: true, toast: 'gone' })
  })
})
