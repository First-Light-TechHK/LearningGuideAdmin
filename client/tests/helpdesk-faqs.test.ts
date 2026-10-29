import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import type { HelpdeskFaq } from '../src/backoffice/contracts/helpdesk'
import {
  FAQ_CATEGORY_SWATCH,
  FAQ_LIMITS,
  applyBold,
  applyLink,
  applyList,
  draftFromFaq,
  emptyFaqDraft,
  faqKeyFor,
  faqQuery,
  faqSaveOutcome,
  isDraftDirty,
  pageWindow,
  parseKeywords,
  readFaqFilters,
  showingRange,
  toFaqBody,
  validateFaqDraft,
  writeFaqFilters,
} from '../src/backoffice/lib/helpdeskFaqs'

/** Tickets v2 §1 / §3a / §3b：FAQ 草稿、校验、工具栏插入、筛选与分页（纯逻辑）。 */

function faq(overrides: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  return {
    id: 'f1',
    category: 'account_technical',
    popular: true,
    questionEn: 'How do I reset my password?',
    answerEn: 'Use **Forgot password**.',
    questionZh: '如何重置密码？',
    answerZh: '使用**忘记密码**。',
    keywords: ['password', 'reset'],
    status: 'published',
    version: 3,
    createdBy: 'e1',
    updatedBy: 'e1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-28T08:30:00Z',
    ...overrides,
  }
}

describe('limits match the server (faqContracts.ts FAQ_LIMITS)', () => {
  test('question 200, answer 4000, 20 keywords of 40, 10 per page', () => {
    assert.deepEqual(
      { ...FAQ_LIMITS },
      { questionMax: 200, answerMax: 4000, keywordsMax: 20, keywordMax: 40, searchMax: 200, pageSize: 10 },
    )
  })
})

describe('draft', () => {
  test('a new FAQ starts empty, not popular', () => {
    assert.deepEqual(emptyFaqDraft(), {
      category: null,
      popular: false,
      questionEn: '',
      answerEn: '',
      questionZh: '',
      answerZh: '',
      keywords: '',
      // v5 question trees: a new FAQ is an answer card and an entry question, with no situations
      type: 'answer',
      entry: true,
      signals: [],
    })
  })

  test('editing copies every field; keywords become comma separated text', () => {
    const draft = draftFromFaq(faq())
    assert.equal(draft.category, 'account_technical')
    assert.equal(draft.popular, true)
    assert.equal(draft.answerZh, '使用**忘记密码**。')
    assert.equal(draft.keywords, 'password, reset')
  })

  test('keywords: comma (also the Chinese comma) separated, trimmed, lower-cased, de-duplicated', () => {
    assert.deepEqual(parseKeywords(' Password, reset ，Login,, password '), ['password', 'reset', 'login'])
    assert.deepEqual(parseKeywords('  '), [])
  })

  test('dirty only when a field really changed', () => {
    const original = draftFromFaq(faq())
    assert.equal(isDraftDirty({ ...original }, original), false)
    assert.equal(isDraftDirty({ ...original, popular: false }, original), true)
    assert.equal(isDraftDirty({ ...emptyFaqDraft() }, emptyFaqDraft()), false)
    assert.equal(isDraftDirty({ ...emptyFaqDraft(), questionEn: 'x' }, emptyFaqDraft()), true)
  })
})

describe('validation (server rules)', () => {
  test('category and all four texts are required; whitespace counts as empty', () => {
    assert.deepEqual(validateFaqDraft({ ...emptyFaqDraft(), questionEn: '   ' }), {
      category: 'required',
      questionEn: 'required',
      answerEn: 'required',
      questionZh: 'required',
      answerZh: 'required',
    })
  })

  test('lengths, keyword limits and unsafe links', () => {
    const base = draftFromFaq(faq())
    assert.deepEqual(validateFaqDraft(base), {})
    assert.deepEqual(
      validateFaqDraft({ ...base, questionEn: 'q'.repeat(201), answerZh: 'a'.repeat(4001) }),
      { questionEn: 'tooLong', answerZh: 'tooLong' },
    )
    assert.deepEqual(validateFaqDraft({ ...base, questionZh: '问'.repeat(200), answerEn: 'a'.repeat(4000) }), {})
    assert.deepEqual(
      validateFaqDraft({ ...base, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`).join(',') }),
      { keywords: 'tooMany' },
    )
    assert.deepEqual(validateFaqDraft({ ...base, keywords: 'k'.repeat(41) }), { keywords: 'tooLong' })
    assert.deepEqual(validateFaqDraft({ ...base, answerEn: 'See [here](javascript:alert(1))' }), { answerEn: 'unsafeLink' })
    assert.deepEqual(validateFaqDraft({ ...base, answerZh: '[邮件](mailto:a@b.test) [网页](https://a.test)' }), {})
  })

  test('the request body is trimmed with parsed keywords', () => {
    const body = toFaqBody({ ...draftFromFaq(faq()), questionEn: '  Q  ', keywords: 'A, b' })
    assert.deepEqual(body, {
      category: 'account_technical',
      popular: true,
      questionEn: 'Q',
      answerEn: 'Use **Forgot password**.',
      questionZh: '如何重置密码？',
      answerZh: '使用**忘记密码**。',
      keywords: ['a', 'b'],
      type: 'answer',
      entry: true,
      signals: [],
    })
  })

  test('v5: card type, entry and situations round-trip; an older server without them reads as an answer entry', () => {
    const draft = draftFromFaq(faq({ type: 'choice', entry: false, signals: ['from_order', 'payment_failed'] }))
    assert.equal(draft.type, 'choice')
    assert.equal(draft.entry, false)
    // the priority order of FAQ_SIGNALS, as the server stores them
    assert.deepEqual(draft.signals, ['payment_failed', 'from_order'])
    const old = draftFromFaq(faq())
    assert.deepEqual([old.type, old.entry, old.signals], ['answer', true, []])
    assert.equal(isDraftDirty({ ...old, signals: ['trial_ending'] }, old), true)
    assert.equal(isDraftDirty({ ...old, signals: [...old.signals] }, old), false)
    assert.equal(isDraftDirty({ ...old, entry: false }, old), true)
    const body = toFaqBody({ ...old, signals: ['email_unverified', 'trial_ending', 'trial_ending'] })
    assert.deepEqual(body.signals, ['trial_ending', 'email_unverified'])
  })

  test('v5: the prompt of a choice question states no facts: no digits, links or emails', () => {
    const base = { ...draftFromFaq(faq()), type: 'choice' as const, answerEn: 'Which one is it?', answerZh: '你遇到的是哪种情况？' }
    assert.deepEqual(validateFaqDraft(base), {})
    assert.deepEqual(validateFaqDraft({ ...base, answerEn: 'Within 14 days?', answerZh: '看 https://a.test' }), {
      answerEn: 'choicePrompt',
      answerZh: 'choicePrompt',
    })
    assert.deepEqual(validateFaqDraft({ ...base, answerZh: '发邮件到 a@b.test' }), { answerZh: 'choicePrompt' })
    // an answer card may say all of that
    assert.deepEqual(validateFaqDraft({ ...base, type: 'answer', answerEn: 'Within 14 days.' }), {})
  })
})

describe('toolbar (inserts exactly the Markdown subset)', () => {
  test('B wraps the selection in **, or inserts **** with the caret in the middle', () => {
    assert.deepEqual(applyBold('reset password now', 6, 14), {
      value: 'reset **password** now',
      selectionStart: 8,
      selectionEnd: 16,
    })
    assert.deepEqual(applyBold('ab', 1, 1), { value: 'a****b', selectionStart: 3, selectionEnd: 3 })
  })

  test('1. numbers every selected line; • prefixes "- "; both start at the line start', () => {
    assert.deepEqual(applyList('Intro\nfirst\nsecond', 8, 15, 'ordered'), {
      value: 'Intro\n1. first\n2. second',
      selectionStart: 6,
      selectionEnd: 24,
    })
    assert.deepEqual(applyList('one', 1, 1, 'bullet'), { value: '- one', selectionStart: 0, selectionEnd: 5 })
    assert.deepEqual(applyList('', 0, 0, 'bullet'), { value: '- ', selectionStart: 2, selectionEnd: 2 })
  })

  test('Link wraps the selection, or uses the URL as the text; unsafe URLs are refused', () => {
    assert.deepEqual(applyLink('Open settings', 5, 13, 'https://a.test/s'), {
      value: 'Open [settings](https://a.test/s)',
      selectionStart: 33,
      selectionEnd: 33,
    })
    assert.deepEqual(applyLink('Mail ', 5, 5, ' mailto:a@b.test '), {
      value: 'Mail [mailto:a@b.test](mailto:a@b.test)',
      selectionStart: 39,
      selectionEnd: 39,
    })
    assert.equal(applyLink('x', 0, 1, 'javascript:alert(1)'), null)
    assert.equal(applyLink('x', 0, 1, 'www.example.com'), null)
  })
})

describe('list filters in the address bar (?tab=faqs&q=&category=&popular=&page=)', () => {
  test('reads valid values, drops unknown ones', () => {
    assert.deepEqual(readFaqFilters(new URLSearchParams('tab=faqs&q=%20reset%20&category=courses_learning&popular=popular&page=2')), {
      q: 'reset',
      category: 'courses_learning',
      popular: 'popular',
      page: 2,
    })
    assert.deepEqual(readFaqFilters(new URLSearchParams('category=billing&popular=maybe&page=-1')), {
      q: '',
      category: 'all',
      popular: 'all',
      page: 1,
    })
  })

  test('writes only non-default values and keeps the tab', () => {
    const next = writeFaqFilters(new URLSearchParams('tab=faqs&page=3'), { category: 'other', page: 1, q: ' ' })
    assert.equal(next.toString(), 'tab=faqs&category=other')
  })

  test('API query: popular true / false, 10 per page', () => {
    assert.equal(faqQuery({ q: '', category: 'all', popular: 'all', page: 1 }), 'page=1&pageSize=10')
    assert.equal(
      faqQuery({ q: ' reset ', category: 'account_technical', popular: 'not_popular', page: 2 }),
      'category=account_technical&popular=false&q=reset&page=2&pageSize=10',
    )
    assert.match(faqQuery({ q: '', category: 'all', popular: 'popular', page: 1 }), /popular=true/)
  })

  test('paging text and buttons', () => {
    assert.deepEqual(showingRange(1, 10, 8), { from: 1, to: 8 })
    assert.deepEqual(showingRange(2, 10, 15), { from: 11, to: 15 })
    assert.deepEqual(showingRange(1, 10, 0), { from: 0, to: 0 })
    assert.deepEqual(pageWindow(1, 1), [1])
    assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5])
    assert.deepEqual(pageWindow(6, 12), [1, 'gap', 5, 6, 7, 'gap', 12])
  })
})

describe('chips (Figma 1379:2)', () => {
  test('category colours are fixed per category', () => {
    assert.deepEqual(FAQ_CATEGORY_SWATCH, {
      account_technical: { bg: '#f2f5f9', fg: '#69778b' },
      courses_learning: { bg: '#f0ebff', fg: '#7655c1' },
      payments_subscriptions: { bg: '#eaf3ff', fg: '#2468df' },
      other: { bg: '#f2f5f9', fg: '#69778b' },
    })
  })
})

describe('saving', () => {
  test('outcome of a save', () => {
    assert.equal(faqSaveOutcome({ ok: true, data: faq() }), 'saved')
    assert.equal(faqSaveOutcome({ ok: false, code: 'VERSION_CONFLICT', status: 409 }), 'conflict')
    assert.equal(faqSaveOutcome({ ok: false, code: 'FAQ_NOT_FOUND', status: 404 }), 'gone')
    assert.equal(faqSaveOutcome({ ok: false, code: 'INVALID_INPUT', status: 400 }), 'error')
  })

  test('Idempotency-Key: the same body retries with the same key, a changed body gets a new one', () => {
    let n = 0
    const make = () => `k${++n}`
    const body = toFaqBody(draftFromFaq(faq()))
    const first = faqKeyFor(null, body, make)
    assert.equal(faqKeyFor(first, { ...body }, make), first)
    assert.notEqual(faqKeyFor(first, { ...body, popular: false }, make).key, first.key)
  })
})
