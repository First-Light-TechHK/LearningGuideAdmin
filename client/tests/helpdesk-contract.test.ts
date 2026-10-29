import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ASSIST_FEEDBACK,
  FAQ_CATEGORIES,
  HELPDESK_CATEGORIES,
  HELPDESK_LOCALES,
  ORDER_KINDS,
  ORDER_STATUSES,
  PAYMENT_MODES,
  TICKET_STATUSES,
  TIMELINE_LIMIT,
} from '../src/backoffice/contracts/helpdesk'
import {
  billingCycleLabel,
  categoryLabel,
  errorMessage,
  faqCategoryLabel,
  formatOrderAmount,
  orderStatusLabel,
  paymentModeLabel,
  statusLabel,
  subscriptionStatusLabel,
} from '../src/backoffice/lib/helpdeskFormat'
import { assistFeedbackTone, ratingValue, subscriptionTone } from '../src/backoffice/lib/helpdeskView'

// The Portal <-> Admin Helpdesk wire contract (fixtures/helpdesk-contract.json, captured from a
// real local run of both apps). The client shows what Portal sends, via the Admin server.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const fixture = JSON.parse(read('./fixtures/helpdesk-contract.json')) as {
  enums: Record<string, string[]> & { agentProblemCode: Record<string, string[]> }
  adminToPortal: {
    timelineRequest: string
    detailResponse: Record<string, unknown>
    listResponse: { tickets: Array<Record<string, unknown>> }
  }
}
const LOCALES = ['en-GB', 'zh-CN'] as const

describe('HelpDesk client against the Portal contract', () => {
  test('the client copy of the fixture is identical to the server copy', () => {
    assert.equal(read('./fixtures/helpdesk-contract.json'), read('../../server/src/backoffice/tests/fixtures/helpdesk-contract.json'))
  })

  test('statuses, enquiry types and locales match Portal', () => {
    assert.deepEqual([...TICKET_STATUSES], fixture.enums.ticketStatus)
    assert.deepEqual([...HELPDESK_CATEGORIES], fixture.enums.category)
    assert.deepEqual([...HELPDESK_LOCALES], fixture.enums.locale)
    for (const locale of LOCALES) {
      for (const status of fixture.enums.ticketStatus) assert.notEqual(statusLabel(locale, status), status, `${locale} ${status}`)
      for (const category of fixture.enums.category) assert.notEqual(categoryLabel(locale, category), category, `${locale} ${category}`)
    }
  })

  test('every subscription status and billing cycle Portal sends has a label in both languages', () => {
    for (const locale of LOCALES) {
      for (const status of fixture.enums.subscriptionStatus) {
        const label = subscriptionStatusLabel(locale, status)
        assert.notEqual(label, status, `${locale} subscription status ${status} has no label`)
        assert.doesNotMatch(label, /_/, `${locale} ${status}`)
      }
      for (const cycle of fixture.enums.billingCycle) {
        assert.notEqual(billingCycleLabel(locale, cycle), cycle, `${locale} billing cycle ${cycle} has no label`)
      }
    }
    assert.equal(billingCycleLabel('en-GB', 'semiannual'), 'Semi-annual')
    assert.equal(billingCycleLabel('zh-CN', 'semiannual'), '按半年')
  })

  test('subscription pill tones: active is green, grace (payment problem) is amber', () => {
    assert.equal(subscriptionTone('active'), 'success')
    assert.equal(subscriptionTone('grace'), 'warning')
    assert.equal(subscriptionTone('cancel_at_period_end'), 'neutral')
  })

  test('every 409 and 422 Portal can answer an agent has its own message', () => {
    const generic = errorMessage('en-GB', 'NO_SUCH_CODE')
    for (const locale of LOCALES) {
      for (const code of [...fixture.enums.agentProblemCode['409'], ...fixture.enums.agentProblemCode['422']]) {
        const message = errorMessage(locale, code.toUpperCase())
        assert.notEqual(message, errorMessage(locale, 'NO_SUCH_CODE'), `${locale} ${code} falls back to the generic message`)
      }
    }
    assert.notEqual(errorMessage('en-GB', 'TAG_LIMIT_REACHED'), generic)
  })

  test('v2: AI assist feedback values match Portal; helpful / solved are green, not_helpful / declined red', () => {
    assert.deepEqual([...ASSIST_FEEDBACK], fixture.enums.assistFeedback)
    assert.deepEqual(
      fixture.enums.assistFeedback.map((value) => assistFeedbackTone(value as (typeof ASSIST_FEEDBACK)[number])),
      ['positive', 'negative', 'positive', 'negative', null],
    )
  })

  test('v2: FAQ categories match the contract and every one has a label in both languages', () => {
    assert.deepEqual([...FAQ_CATEGORIES], fixture.enums.faqCategory)
    for (const locale of LOCALES) {
      for (const category of fixture.enums.faqCategory) {
        assert.notEqual(faqCategoryLabel(locale, category), category, `${locale} ${category}`)
      }
    }
    assert.equal(faqCategoryLabel('en-GB', 'account_technical'), 'Account & Technical Support')
    assert.equal(faqCategoryLabel('zh-CN', 'other'), '其他问题')
  })

  test('v2: agent actions include flag / unflag; the detail carries flagged; the timeline asks for 10', () => {
    assert.ok(fixture.enums.agentAction.includes('flag'))
    assert.ok(fixture.enums.agentAction.includes('unflag'))
    assert.equal(typeof fixture.adminToPortal.detailResponse.flagged, 'boolean')
    const query = new URL(fixture.adminToPortal.timelineRequest, 'http://x').searchParams
    assert.equal(Number(query.get('limit')), TIMELINE_LIMIT)
  })

  test('v4: aiAssist items carry the learner rating as Portal sends it; the AI block shows a number 1-5, nothing for null', () => {
    const items = fixture.adminToPortal.detailResponse.aiAssist as Array<{ rating: unknown }>
    assert.deepEqual(items.map((item) => item.rating), [4, null])
    assert.deepEqual(items.map((item) => ratingValue(item.rating)), [4, null])
  })

  test('v5: order statuses and payment modes match Portal and every one has a label in both languages', () => {
    assert.deepEqual([...ORDER_STATUSES], fixture.enums.orderStatus)
    assert.deepEqual([...ORDER_KINDS], fixture.enums.orderKind)
    assert.deepEqual([...PAYMENT_MODES], fixture.enums.paymentMode)
    for (const locale of LOCALES) {
      for (const status of fixture.enums.orderStatus) {
        const label = orderStatusLabel(locale, status)
        assert.notEqual(label, status, `${locale} order status ${status} has no label`)
        assert.doesNotMatch(label, /_/, `${locale} ${status}`)
      }
      for (const mode of fixture.enums.paymentMode) {
        assert.notEqual(paymentModeLabel(locale, mode), mode, `${locale} payment mode ${mode} has no label`)
      }
    }
  })

  test('v5: the captured order is the 8-field projection; its amount is minor units in a lower-case currency', () => {
    const order = fixture.adminToPortal.detailResponse.order as Record<string, unknown>
    assert.deepEqual(Object.keys(order).sort(), ['amount', 'createdAt', 'currency', 'id', 'kind', 'paymentMode', 'planName', 'status'])
    assert.equal(fixture.adminToPortal.detailResponse.orderId, order.id)
    assert.equal(order.amount, 3900)
    assert.equal(order.currency, 'usd')
    for (const locale of LOCALES) assert.match(formatOrderAmount(locale, order.amount as number, order.currency as string), /39\.00/)
    assert.ok(fixture.adminToPortal.listResponse.tickets.some((ticket) => typeof ticket.orderId === 'string'))
  })
})
