import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import enGB from '../src/backoffice/messages/en-GB.json'
import zhCN from '../src/backoffice/messages/zh-CN.json'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  )
}

function get(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, part) => (cursor as Record<string, unknown> | undefined)?.[part], source)
}

const root = new URL('../src/', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

describe('HelpDesk messages', () => {
  test('en-GB and zh-CN have exactly the same helpDesk keys, none empty', () => {
    const en = keys(enGB.helpDesk).sort()
    const zh = keys((zhCN as typeof enGB).helpDesk).sort()
    assert.deepEqual(zh, en)
    for (const key of en) {
      assert.notEqual(String(get(enGB.helpDesk, key)).trim(), '', `en-GB helpDesk.${key} is empty`)
      assert.notEqual(String(get(zhCN.helpDesk, key)).trim(), '', `zh-CN helpDesk.${key} is empty`)
    }
  })

  test('Figma 1324:2 wording (en-GB)', () => {
    const h = enGB.helpDesk as Record<string, unknown>
    assert.equal(get(h, 'title'), 'Help Desk')
    assert.equal(get(h, 'subtitle'), 'Manage student enquiries and common questions')
    assert.equal(get(h, 'addQuestion'), 'Add Question')
    assert.equal(get(h, 'tabs.enquiries'), 'Enquiries')
    assert.equal(get(h, 'tabs.questions'), 'Common Questions')
    assert.equal(get(h, 'searchPlaceholder'), 'Search students or enquiries...')
    assert.equal(get(h, 'markReviewed'), 'Mark as reviewed')
    assert.equal(get(h, 'student.title'), 'Student Information')
    assert.equal(get(h, 'student.accountEmail'), 'Account Email')
    assert.equal(get(h, 'student.contactEmail'), 'Contact Email')
    assert.equal(get(h, 'student.joinedAt'), 'Joined Date')
    assert.equal(get(h, 'student.id'), 'Student ID')
    assert.equal(get(h, 'student.totalEnquiries'), 'Total Enquiries')
    assert.equal(get(h, 'student.currentCourse'), 'Current Course')
    assert.equal(get(h, 'subscription.title'), 'Current Subscription Plan')
    assert.equal(get(h, 'subscription.planName'), 'Plan Name')
    assert.equal(get(h, 'subscription.billingCycle'), 'Billing Cycle')
    assert.equal(get(h, 'subscription.status'), 'Status')
    assert.equal(get(h, 'subscription.renewalDate'), 'Renewal Date')
    assert.equal(get(h, 'tags.title'), 'Tags')
    assert.equal(get(h, 'tags.add'), 'Add Tag')
  })

  test('the four Enquiry Types replace the old categories', () => {
    for (const bundle of [enGB, zhCN]) {
      assert.deepEqual(Object.keys(get(bundle, 'helpDesk.category') as object).sort(), [
        'course_content',
        'other',
        'payments_subscriptions',
        'technical_support',
      ])
    }
    assert.equal(get(enGB, 'helpDesk.category.payments_subscriptions'), 'Payments & Subscriptions')
    assert.equal(get(enGB, 'helpDesk.category.other'), 'Other Enquiries')
  })

  test('every error code the pages can receive has a message', () => {
    for (const code of [
      'HELPDESK_NOT_CONNECTED',
      'HELPDESK_UNAVAILABLE',
      'TICKET_NOT_FOUND',
      'STALE_TICKET',
      'INVALID_TRANSITION',
      'IDEMPOTENCY_CONFLICT',
      'INVALID_INPUT',
      'NOT_AUTHORISED',
      'RATE_LIMITED',
      'VERSION_CONFLICT',
      'QUESTION_NOT_FOUND',
      'generic',
    ]) {
      assert.equal(typeof get(enGB, `helpDesk.errors.${code}`), 'string', code)
    }
  })

  test('the old card-board wording is gone', () => {
    for (const bundle of [enGB, zhCN]) {
      const h = bundle.helpDesk as Record<string, unknown>
      for (const key of [
        'tabs.needsReply',
        'loadMore',
        'detail.back',
        // card-board leftovers; the filter keeps its own helpDesk.filters.needsReply
        'needsReply',
        'unassigned',
        'assignedTo',
        // the Common Questions table has no Featured column (featured is a tag in the status cell)
        'questions.columns.featured',
      ]) {
        assert.equal(get(h, key), undefined, key)
      }
      assert.equal(typeof get(h, 'filters.needsReply'), 'string')
      assert.equal(typeof get(h, 'questions.featured'), 'string')
    }
  })

  test('"Question saved." is what + Add Question / Save confirms with', () => {
    assert.equal(get(enGB, 'helpDesk.questions.saved'), 'Question saved.')
    assert.match(read('backoffice/pages/HelpDeskPage.tsx'), /'helpDesk\.questions\.saved'/)
  })
})

describe('HelpDesk wiring', () => {
  test('the card board and the separate ticket page are removed', () => {
    assert.equal(existsSync(new URL('backoffice/pages/HelpDeskTicketPage.tsx', root)), false)
    const app = read('App.tsx')
    assert.doesNotMatch(app, /HelpDeskTicketPage/)
  })

  test('one route with an optional :ticketId renders the three-column page behind the helpDesk menu', () => {
    const app = read('App.tsx')
    assert.equal(app.match(/path="help-desk[^"]*"/g)?.length, 1, 'exactly one help-desk route')
    const index = app.indexOf('path="help-desk/:ticketId?"')
    assert.ok(index > 0, 'route help-desk/:ticketId? missing')
    const block = app.slice(index, index + 400)
    assert.match(block, /<MenuGuard menu="helpDesk">/)
    assert.match(block, /<WorkspaceAccessProvider menu="helpDesk">/)
    assert.match(block, /<HelpDeskPage \/>/)
  })

  test('no front-end tracking in the HelpDesk code (owner: 现在先不做埋点)', () => {
    const sources = [
      'backoffice/pages/HelpDeskPage.tsx',
      'backoffice/lib/helpdeskApi.ts',
      'backoffice/lib/helpdeskView.ts',
      'backoffice/lib/helpdeskQuestions.ts',
    ].map(read)
    for (const source of sources) assert.doesNotMatch(source, /analytics|gtag|track\(|sendBeacon|traceparent/i)
  })
})
