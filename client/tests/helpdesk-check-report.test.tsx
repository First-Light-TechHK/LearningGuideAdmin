import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, render } from '@testing-library/react'

import type { FaqEvalSuite, FaqReleaseEvalReport } from '../src/backoffice/contracts/helpdesk'
import { FaqCheckReport } from '../src/backoffice/helpdesk/FaqCheckReport'

/**
 * Release check details: why a suite did not pass, written from the suite's numbers and the limits in the
 * receipt (the same rules as the server's release-check/policy.ts, 2026-11-09): absolute lines on S650 only,
 * the blind set compared with the live version in both directions, the screen suite's own line.
 */

const suite = (id: string, extra: Partial<FaqEvalSuite> = {}): FaqEvalSuite => ({
  id,
  label: `server label ${id}`,
  status: 'gate',
  rule: 'paired',
  passed: true,
  n: 250,
  metrics: { scored: 250, wrongRate: 0, wrongRateHigh: 0.015, confirmedWorse: 0 },
  reasons: [],
  ...extra,
})

const report = (suites: FaqEvalSuite[], receipt: Record<string, string | number>): FaqReleaseEvalReport => ({
  kind: 'model',
  passed: false,
  summary: '',
  ranAt: '2026-11-09T23:00:00.000Z',
  metrics: {},
  misses: [],
  suites,
  receipt,
})

const LIMITS = { wrongRateMax: 0.02, sliceMin: 200, rightDropMax: 0.01, cardWhenNoneMax: 0.03 }

afterEach(() => cleanup())

describe('release check details: suites', () => {
  test('names the new suites and says why a suite did not pass: right answers fell, cards for out-of-library questions', () => {
    const view = render(
      <FaqCheckReport
        locale="zh-CN"
        report={report(
          [
            suite('s650', {
              rule: 'interval',
              passed: false,
              metrics: { scored: 1400, wrongRate: 0.01, wrongRateHigh: 0.017, cardWhenNoneRate: 0.05, cardWhenNoneOver: 1 },
              reasons: ['server reason'],
            }),
            suite('blind', {
              passed: false,
              metrics: {
                scored: 274,
                wrongRate: 0.084,
                wrongRateHigh: 0.123,
                liveRightRate: 0.86,
                pairedRightRate: 0.84,
                lostRight: 6,
                gainedRight: 1,
                rightDropped: 1,
              },
            }),
            suite('blindNone', { status: 'track', n: 21 }),
            suite('screen', {
              status: 'track',
              n: 200,
              metrics: { scored: 200, wrongRate: 0.05, wrongRateHigh: 0.09, screenPairs: 200, screenChanged: 14, screenLost: 9 },
            }),
          ],
          LIMITS,
        )}
      />,
    )
    const text = view.container.textContent ?? ''
    assert.ok(text.includes('盲测里库里没卡的题'))
    assert.ok(text.includes('屏幕上开着别的卡时问新问题'))
    assert.ok(text.includes('库里没卡的题有 5.0% 出了卡，超过 3.0%'))
    assert.ok(text.includes('答对率比线上从 86.0% 掉到 84.0%（丢 6 道、新答对 1 道），超过 1.0%'))
    assert.ok(text.includes('同样的题不带卡时对照 200 道：带上旧卡后回答变了 14 道，原本答对的丢了 9 道'))
    // written here from the numbers, not the server's English sentence
    assert.ok(!text.includes('server reason'))
  })

  test('a report from before these rules (no such limits in its receipt) still shows what it has', () => {
    const view = render(
      <FaqCheckReport
        locale="en-GB"
        report={report(
          [suite('combined', { rule: 'interval', passed: false, metrics: { scored: 1684, wrongRate: 0.023, wrongRateHigh: 0.031, rightDropped: 1 } })],
          { wrongRateMax: 0.02, sliceMin: 200 },
        )}
      />,
    )
    const text = view.container.textContent ?? ''
    assert.ok(text.includes('Wrong-card 95% upper bound 3.1% is above 2.0%'))
    assert.ok(!text.includes('Right answers fell'))
  })
})
