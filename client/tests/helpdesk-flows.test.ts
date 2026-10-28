import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { afterFaqSave } from '../src/backoffice/lib/helpdeskFaqs'
import {
  clearBusy,
  composerKey,
  helpDeskPageControls,
  isImeComposing,
  markReadOnOpen,
  resyncQuery,
  settlePlan,
  NO_BUSY,
  startBusy,
  visibleBusy,
} from '../src/backoffice/lib/helpdeskView'

/**
 * Decision logic the HelpDesk components run (no DOM: the client tests are node:test on
 * plain .ts, there is no jsdom / testing-library). Each function here is what one component
 * calls at that point, so these tests lock the behaviour, not just a helper.
 */

const AVAILABLE = {
  claim: true,
  reply: true,
  internalNote: true,
  proposeResolution: true,
  tag: true,
  markRead: true,
  flag: true,
}

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
    const busy = startBusy(NO_BUSY, 'A', { label: 'send' })
    assert.equal(visibleBusy(busy, 'A'), 'send')
    assert.equal(visibleBusy(busy, 'B'), null)
    assert.equal(visibleBusy(NO_BUSY, 'A'), null)
    assert.equal(visibleBusy(busy, null), null)
  })

  test('A, then B, then B finishes: A\'s write is still running, so A stays disabled when the agent goes back', () => {
    const a = { label: 'claim' }
    const b = { label: 'tag' }
    const afterB = clearBusy(startBusy(startBusy(NO_BUSY, 'A', a), 'B', b), 'B', b)
    assert.equal(visibleBusy(afterB, 'A'), 'claim')
    assert.equal(visibleBusy(afterB, 'B'), null)
    assert.equal(visibleBusy(clearBusy(afterB, 'A', a), 'A'), null)
  })

  test('a late finish only clears the write that set the flag', () => {
    const first = { label: 'send' }
    const second = { label: 'claim' }
    const busy = startBusy(clearBusy(startBusy(NO_BUSY, 'A', first), 'A', first), 'A', second)
    assert.equal(visibleBusy(clearBusy(busy, 'A', first), 'A'), 'claim')
    assert.equal(visibleBusy(clearBusy(busy, 'B', second), 'A'), 'claim')
    assert.equal(clearBusy(NO_BUSY, 'A', first), NO_BUSY)
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
  test('FULL gets + Add FAQ and the drawer; VIEW gets neither', () => {
    assert.deepEqual(helpDeskPageControls(true), { addFaq: true, faqDrawer: true })
    assert.deepEqual(helpDeskPageControls(false), { addFaq: false, faqDrawer: false })
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

describe('FAQ drawer results on the page (HelpDeskPage)', () => {
  test('saved / deleted -> toast, close, refresh; gone -> refresh, close, error toast', () => {
    assert.deepEqual(afterFaqSave('saved'), { refresh: true, close: true, toast: 'saved' })
    assert.deepEqual(afterFaqSave('deleted'), { refresh: true, close: true, toast: 'deleted' })
    assert.deepEqual(afterFaqSave('gone'), { refresh: true, close: true, toast: 'gone' })
  })
})
