import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { HELPDESK_CATEGORIES, HELPDESK_LOCALES, TICKET_STATUSES } from '../src/backoffice/contracts/helpdesk'
import {
  billingCycleLabel,
  categoryLabel,
  errorMessage,
  statusLabel,
  subscriptionStatusLabel,
} from '../src/backoffice/lib/helpdeskFormat'
import { subscriptionTone } from '../src/backoffice/lib/helpdeskView'

// The Portal <-> Admin Helpdesk wire contract (fixtures/helpdesk-contract.json, captured from a
// real local run of both apps). The client shows what Portal sends, via the Admin server.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const fixture = JSON.parse(read('./fixtures/helpdesk-contract.json')) as {
  enums: Record<string, string[]> & { agentProblemCode: Record<string, string[]> }
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

  test('every 409 Portal can answer an agent has its own message', () => {
    const generic = errorMessage('en-GB', 'NO_SUCH_CODE')
    for (const locale of LOCALES) {
      for (const code of fixture.enums.agentProblemCode['409']) {
        const message = errorMessage(locale, code.toUpperCase())
        assert.notEqual(message, errorMessage(locale, 'NO_SUCH_CODE'), `${locale} ${code} falls back to the generic message`)
      }
    }
    assert.notEqual(errorMessage('en-GB', 'TAG_LIMIT_REACHED'), generic)
  })
})
