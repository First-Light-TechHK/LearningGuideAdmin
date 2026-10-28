import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  QUESTION_LIMITS,
  canReorder,
  draftFromQuestion,
  emptyDraft,
  moveQuestion,
  normalizeKeywords,
  questionActions,
  questionQuery,
  toCreateBody,
  toUpdateBody,
  validateDraft,
} from '../src/backoffice/lib/helpdeskQuestions'

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    locale: 'en-GB' as const,
    category: 'technical_support' as const,
    question: 'How do I reset my password?',
    answer: 'Use the Forgot password link.',
    keywords: ['password'],
    status: 'draft' as const,
    featured: false,
    sortOrder: 10,
    version: 3,
    createdBy: 'e1',
    updatedBy: 'e1',
    createdAt: '2026-10-28T10:00:00Z',
    updatedAt: '2026-10-28T10:00:00Z',
    stats: { shown: 0, solved: 0, declined: 0 },
    ...overrides,
  }
}

describe('limits match the server (questionContracts.ts)', () => {
  test('question 200, answer 4000, 20 keywords of 40', () => {
    assert.deepEqual(
      { ...QUESTION_LIMITS },
      { questionMax: 200, answerMax: 4000, keywordsMax: 20, keywordMax: 40, searchMax: 200 },
    )
  })
})

describe('draft', () => {
  test('a new draft uses the given locale and is not published', () => {
    assert.deepEqual(emptyDraft('zh-CN'), {
      locale: 'zh-CN',
      category: null,
      question: '',
      answer: '',
      keywords: [],
      featured: false,
      publish: false,
    })
  })

  test('editing copies the question fields', () => {
    const draft = draftFromQuestion(question({ featured: true, keywords: ['a', 'b'] }))
    assert.equal(draft.question, 'How do I reset my password?')
    assert.equal(draft.featured, true)
    assert.deepEqual(draft.keywords, ['a', 'b'])
    assert.equal(draft.publish, false)
  })

  test('keywords are trimmed, lower-cased and de-duplicated', () => {
    assert.deepEqual(normalizeKeywords([' Password ', 'password', '', 'Login']), ['password', 'login'])
  })

  test('validation: required fields and lengths', () => {
    assert.deepEqual(validateDraft(emptyDraft('en-GB')), {
      category: 'required',
      question: 'required',
      answer: 'required',
    })
    const tooLong = {
      ...emptyDraft('en-GB'),
      category: 'other' as const,
      question: 'q'.repeat(201),
      answer: 'a'.repeat(4001),
      keywords: Array.from({ length: 21 }, (_, i) => `k${i}`),
    }
    assert.deepEqual(validateDraft(tooLong), { question: 'tooLong', answer: 'tooLong', keywords: 'tooMany' })
    assert.deepEqual(
      validateDraft({ ...tooLong, question: 'ok', answer: 'ok', keywords: ['k'.repeat(41)] }),
      { keywords: 'tooLong' },
    )
    assert.deepEqual(validateDraft({ ...tooLong, question: '  ok ', answer: 'ok', keywords: [] }), {})
  })

  test('request bodies: create carries publish, update carries version', () => {
    const draft = { ...emptyDraft('en-GB'), category: 'other' as const, question: ' Q ', answer: ' A ', keywords: [' K '], publish: true }
    assert.deepEqual(toCreateBody(draft), {
      locale: 'en-GB',
      category: 'other',
      question: 'Q',
      answer: 'A',
      keywords: ['k'],
      featured: false,
      publish: true,
    })
    assert.deepEqual(toUpdateBody(draft, 7), {
      version: 7,
      locale: 'en-GB',
      category: 'other',
      question: 'Q',
      answer: 'A',
      keywords: ['k'],
      featured: false,
    })
  })
})

describe('filters and ordering', () => {
  test('API query leaves out "all" filters and trims the search', () => {
    assert.equal(questionQuery({ locale: 'all', category: 'all', status: 'active', q: '  ' }), '')
    const query = new URLSearchParams(
      questionQuery({ locale: 'zh-CN', category: 'other', status: 'archived', q: ' refund ' }),
    )
    assert.equal(query.get('locale'), 'zh-CN')
    assert.equal(query.get('category'), 'other')
    assert.equal(query.get('status'), 'archived')
    assert.equal(query.get('q'), 'refund')
    assert.equal(new URLSearchParams(questionQuery({ locale: 'all', category: 'all', status: 'all', q: '' })).get('status'), 'all')
  })

  test('sorting is only offered for one language with no other filter', () => {
    assert.equal(canReorder({ locale: 'en-GB', category: 'all', status: 'active', q: '' }), true)
    assert.equal(canReorder({ locale: 'all', category: 'all', status: 'active', q: '' }), false)
    assert.equal(canReorder({ locale: 'en-GB', category: 'other', status: 'active', q: '' }), false)
    assert.equal(canReorder({ locale: 'en-GB', category: 'all', status: 'published', q: '' }), false)
    assert.equal(canReorder({ locale: 'en-GB', category: 'all', status: 'active', q: 'x' }), false)
  })

  test('moveQuestion swaps neighbours and returns the whole order with versions', () => {
    const rows = [question({ id: 'a', version: 1 }), question({ id: 'b', version: 2 }), question({ id: 'c', version: 5 })]
    assert.deepEqual(moveQuestion(rows, 2, -1), [
      { id: 'a', version: 1 },
      { id: 'c', version: 5 },
      { id: 'b', version: 2 },
    ])
    assert.equal(moveQuestion(rows, 0, -1), null)
    assert.equal(moveQuestion(rows, 2, 1), null)
  })
})

describe('row actions (VIEW sees none)', () => {
  test('draft: edit, publish, archive', () => {
    assert.deepEqual(questionActions(question({ status: 'draft' }), true), {
      edit: true,
      publish: true,
      unpublish: false,
      archive: true,
      reorder: true,
    })
  })
  test('published: edit, unpublish, archive', () => {
    assert.deepEqual(questionActions(question({ status: 'published' }), true), {
      edit: true,
      publish: false,
      unpublish: true,
      archive: true,
      reorder: true,
    })
  })
  test('archived: only publish again (no edit, no archive)', () => {
    assert.deepEqual(questionActions(question({ status: 'archived' }), true), {
      edit: false,
      publish: true,
      unpublish: false,
      archive: false,
      reorder: false,
    })
  })
  test('VIEW role: nothing', () => {
    assert.deepEqual(questionActions(question({ status: 'draft' }), false), {
      edit: false,
      publish: false,
      unpublish: false,
      archive: false,
      reorder: false,
    })
  })
})
