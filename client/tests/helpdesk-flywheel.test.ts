import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_ORIGINS,
  CANDIDATE_STATUSES,
  CANDIDATE_SUGGESTIONS,
  DISMISS_REASONS,
  METRICS_SPLITS,
  SOURCE_MIX_KEYS,
  type FaqCandidateDraft,
  type FlywheelMetrics,
} from '../src/backoffice/contracts/helpdesk'
import {
  CANDIDATE_PAGE_SIZE,
  DEFAULT_CANDIDATE_FILTERS,
  METRICS_RANGES,
  RATE_KEYS,
  canDecide,
  canTurnIntoCandidate,
  candidateQuery,
  cleanExampleIndexes,
  decisionKey,
  faqDraftFromCandidate,
  formatRate,
  formatRating,
  hasPlaceholder,
  metricsQuery,
  metricsWindow,
  miningRunSummary,
  overallTotals,
  readCandidateFilters,
  sourceMixEntries,
  textSegments,
  writeCandidateFilters,
} from '../src/backoffice/lib/helpdeskFlywheel'
import { candidate } from './support/helpdesk-fake'

/**
 * v5 Part G4 / G6（待视觉验收）：FAQ 候选队列与 HelpDesk 数据页的纯逻辑。
 * 枚举与 Admin Server（candidateRepository.ts、flywheelMining.ts、flywheelMetrics.ts）一致。
 */

describe('flywheel enums match the Admin server', () => {
  test('candidate statuses, suggestions, origins, dismiss reasons, source mix keys and splits', () => {
    assert.deepEqual(CANDIDATE_STATUSES, ['new', 'accepted', 'dismissed', 'merged'])
    assert.deepEqual(CANDIDATE_SUGGESTIONS, ['new_faq', 'add_phrasing', 'follow_up', 'update_faq', 'retire_faq'])
    assert.deepEqual(CANDIDATE_ORIGINS, ['mining', 'ticket'])
    assert.deepEqual(DISMISS_REASONS, ['duplicate', 'not_a_gap', 'out_of_scope', 'personal_data', 'spam', 'other'])
    assert.deepEqual(SOURCE_MIX_KEYS, [
      'no_match',
      'not_helpful',
      'clarify_not_covered',
      'handover',
      'ticket_after_chat',
      'low_rating',
      'ticket',
    ])
    assert.deepEqual(METRICS_SPLITS, ['none', 'locale', 'entry', 'signal'])
    assert.deepEqual(RATE_KEYS, [
      'aiSolvedRate',
      'noMatchRate',
      'helpfulRate',
      'avgRating',
      'handoverRate',
      'clarifyCoveredRate',
      'guardFallbackRate',
    ])
  })
})

describe('candidate queue filters (address bar)', () => {
  test('defaults: the open queue (status new), first page', () => {
    assert.deepEqual(readCandidateFilters(new URLSearchParams('tab=candidates')), DEFAULT_CANDIDATE_FILTERS)
    assert.deepEqual(DEFAULT_CANDIDATE_FILTERS, { status: 'new', suggestion: 'all', origin: 'all', q: '', page: 1 })
  })

  test('reads known values and drops unknown ones', () => {
    assert.deepEqual(
      readCandidateFilters(new URLSearchParams('status=dismissed&suggestion=add_phrasing&origin=ticket&q=refund&page=3')),
      { status: 'dismissed', suggestion: 'add_phrasing', origin: 'ticket', q: 'refund', page: 3 },
    )
    assert.deepEqual(readCandidateFilters(new URLSearchParams('status=all')).status, 'all')
    assert.deepEqual(
      readCandidateFilters(new URLSearchParams('status=bogus&suggestion=x&origin=y&page=-2')),
      DEFAULT_CANDIDATE_FILTERS,
    )
    assert.equal(readCandidateFilters(new URLSearchParams(`q=${'a'.repeat(150)}`)).q.length, 100)
  })

  test('writing keeps the tab and other parameters, drops defaults', () => {
    const next = writeCandidateFilters(new URLSearchParams('tab=candidates&candidate=c1'), {
      status: 'all',
      origin: 'ticket',
      page: 2,
    })
    assert.equal(next.toString(), 'tab=candidates&candidate=c1&status=all&origin=ticket&page=2')
    const back = writeCandidateFilters(next, { status: 'new', origin: 'all', page: 1 })
    assert.equal(back.toString(), 'tab=candidates&candidate=c1')
  })

  test('the server query: status (unless all), suggestion, origin, q, page and page size', () => {
    assert.equal(candidateQuery(DEFAULT_CANDIDATE_FILTERS), `status=new&page=1&pageSize=${CANDIDATE_PAGE_SIZE}`)
    assert.equal(
      candidateQuery({ status: 'all', suggestion: 'follow_up', origin: 'mining', q: '  退款 ', page: 2 }),
      'suggestion=follow_up&origin=mining&q=%E9%80%80%E6%AC%BE&page=2&pageSize=20',
    )
  })
})

describe('scrubbed examples', () => {
  test('placeholders (<email>, <phone> …) are split out so they can be shown as hidden details', () => {
    assert.equal(hasPlaceholder('my email is <email>'), true)
    assert.equal(hasPlaceholder('how do I get a refund'), false)
    assert.deepEqual(textSegments('call <phone> or mail <email>.'), [
      { text: 'call ', placeholder: null },
      { text: '<phone>', placeholder: 'phone' },
      { text: ' or mail ', placeholder: null },
      { text: '<email>', placeholder: 'email' },
      { text: '.', placeholder: null },
    ])
    assert.deepEqual(textSegments('plain'), [{ text: 'plain', placeholder: null }])
  })

  test('only examples without a hidden detail can become phrasings (the server rejects the others)', () => {
    const examples = [
      { turnId: 't1', text: 'refund please', locale: 'en-GB' as const, reasons: ['no_match' as const] },
      { turnId: 't2', text: 'refund to <email>', locale: 'en-GB' as const, reasons: ['handover' as const] },
      { turnId: 't3', text: '怎么退款', locale: 'zh-CN' as const, reasons: ['no_match' as const] },
    ]
    assert.deepEqual(cleanExampleIndexes(examples), [0, 2])
  })

  test('the source mix, biggest first (ties in the server order), zero counts left out', () => {
    assert.deepEqual(sourceMixEntries({ ticket: 1, handover: 4, no_match: 4, low_rating: 0 }), [
      ['no_match', 4],
      ['handover', 4],
      ['ticket', 1],
    ])
    assert.deepEqual(sourceMixEntries({}), [])
  })
})

describe('decisions', () => {
  test('only FULL staff decide, and only on an open (new) candidate', () => {
    assert.equal(canDecide(candidate('a'), true), true)
    assert.equal(canDecide(candidate('a'), false), false)
    for (const status of ['accepted', 'dismissed', 'merged'] as const)
      assert.equal(canDecide(candidate('a', { status }), true), false, status)
  })

  test('a retry of the same decision reuses its Idempotency-Key; a different decision gets a new one', () => {
    let n = 0
    const make = () => `key-${++n}`
    const first = decisionKey(null, { as: 'add_phrasing', faqId: 'f1' }, make)
    assert.equal(first.key, 'key-1')
    assert.equal(decisionKey(first, { as: 'add_phrasing', faqId: 'f1' }, make), first)
    assert.equal(decisionKey(first, { as: 'add_phrasing', faqId: 'f2' }, make).key, 'key-2')
  })

  test('the FAQ editor prefill: questions and category from the draft, answers empty, entry unless follow-up', () => {
    const draft: FaqCandidateDraft = {
      candidateId: 'c1',
      version: 2,
      suggestion: 'new_faq',
      faq: {
        type: 'answer',
        entry: true,
        category: 'payments_subscriptions',
        questionEn: 'How do I get a refund?',
        questionZh: '怎么退款？',
        answerEn: '',
        answerZh: '',
        keywords: [],
      },
      parentId: null,
      relatedNodeId: null,
      phrasings: [],
      answerDraft: null,
    }
    assert.deepEqual(faqDraftFromCandidate(draft, 'new_faq'), {
      category: 'payments_subscriptions',
      popular: false,
      questionEn: 'How do I get a refund?',
      answerEn: '',
      questionZh: '怎么退款？',
      answerZh: '',
      keywords: '',
      type: 'answer',
      entry: true,
      signals: [],
    })
    assert.equal(faqDraftFromCandidate(draft, 'follow_up').entry, false)
    // 不认识的分类（模型的标签或旧数据）：让员工选
    assert.equal(faqDraftFromCandidate({ ...draft, faq: { ...draft.faq, category: 'bogus' } }, 'new_faq').category, null)
    assert.equal(faqDraftFromCandidate({ ...draft, faq: { ...draft.faq, category: null } }, 'new_faq').category, null)
  })
})

describe('"转成 FAQ 候选" on a ticket', () => {
  test('only FULL staff, only a resolved ticket (CLOSED, not cancelled by the learner)', () => {
    assert.equal(canTurnIntoCandidate({ status: 'CLOSED', closeReason: 'user_confirmed' }, true), true)
    assert.equal(canTurnIntoCandidate({ status: 'CLOSED', closeReason: null }, true), true)
    assert.equal(canTurnIntoCandidate({ status: 'CLOSED', closeReason: 'cancelled' }, true), false)
    assert.equal(canTurnIntoCandidate({ status: 'CANCELLED', closeReason: 'cancelled' }, true), false)
    assert.equal(canTurnIntoCandidate({ status: 'PENDING_CONFIRM' }, true), false)
    assert.equal(canTurnIntoCandidate({ status: 'CLOSED', closeReason: 'user_confirmed' }, false), false)
  })
})

describe('metrics', () => {
  test('rates as percentages with one decimal, the rating with two; null is a dash', () => {
    assert.equal(formatRate(0.4567), '45.7%')
    assert.equal(formatRate(1), '100.0%')
    assert.equal(formatRate(0), '0.0%')
    assert.equal(formatRate(null), '—')
    assert.equal(formatRating(4.256), '4.26')
    assert.equal(formatRating(null), '—')
  })

  test('the window ends today: daily ranges in days, weekly ranges in weeks, within the server limits', () => {
    assert.deepEqual(METRICS_RANGES, { day: [7, 28, 92], week: [12, 26, 52] })
    assert.deepEqual(metricsWindow('day', 7, '2026-10-30'), { from: '2026-10-24', to: '2026-10-30' })
    assert.deepEqual(metricsWindow('day', 92, '2026-10-30'), { from: '2026-07-31', to: '2026-10-30' })
    assert.deepEqual(metricsWindow('week', 12, '2026-10-30'), { from: '2026-08-08', to: '2026-10-30' })
    const longest = metricsWindow('week', 52, '2026-10-30')
    const days = (Date.parse(longest.to) - Date.parse(longest.from)) / 86_400_000 + 1
    assert.ok(days <= 366, `${days} days`)
  })

  test('the server query', () => {
    assert.equal(
      metricsQuery({ granularity: 'week', from: '2026-08-08', to: '2026-10-30', split: 'none' }),
      'granularity=week&from=2026-08-08&to=2026-10-30&split=none',
    )
  })

  test('the overall totals are the one segment of an unsplit answer; nothing when there is no data', () => {
    const row = {
      bucket: null,
      segment: 'all',
      turns: 4,
      answers: 2,
      answersSettled: 2,
      aiSolved: 1,
      noMatch: 1,
      votes: 0,
      helpful: 0,
      ratings: 0,
      ratingSum: 0,
      handovers: 0,
      clarify: 0,
      clarifyCovered: 0,
      guarded: 0,
      guardFallback: 0,
      unsolved: 1,
      aiSolvedRate: 0.5,
      noMatchRate: 0.25,
      helpfulRate: null,
      avgRating: null,
      handoverRate: 0,
      clarifyCoveredRate: null,
      guardFallbackRate: null,
    }
    const metrics = { split: 'none', totals: [row] } as unknown as FlywheelMetrics
    assert.equal(overallTotals(metrics), row)
    assert.equal(overallTotals({ ...metrics, totals: [] }), null)
    assert.equal(overallTotals({ ...metrics, totals: [{ ...row, turns: 0 }] }), null)
    assert.equal(overallTotals({ ...metrics, split: 'locale' }), null)
  })

  test('a mining run summary reads the pull and mine counts; anything missing is 0', () => {
    assert.deepEqual(
      miningRunSummary({ pull: { status: 'pulled', received: 120 }, mine: { created: 3, grown: 2, turnsAdded: 17 } }),
      { pull: 'pulled', received: 120, created: 3, grown: 2 },
    )
    assert.deepEqual(miningRunSummary({}), { pull: null, received: 0, created: 0, grown: 0 })
  })
})
