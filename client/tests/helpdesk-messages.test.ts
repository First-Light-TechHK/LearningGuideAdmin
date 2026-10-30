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
    assert.equal(get(h, 'subtitle'), 'Manage student enquiries and FAQs')
    assert.equal(get(h, 'addFaq'), 'Add FAQ')
    assert.equal(get(h, 'tabs.enquiries'), 'Enquiries')
    assert.equal(get(h, 'tabs.faqs'), 'FAQs')
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
    // v2 middle column: the four action-bar buttons and the AI blocks
    assert.equal(get(h, 'actions.emailStudent'), 'Email student')
    assert.equal(get(h, 'actions.internalNotes'), 'Internal notes')
    assert.equal(get(h, 'actions.flag'), 'Flag follow-up')
    assert.equal(get(h, 'ai.title'), 'AI Support Assistant')
    assert.equal(get(h, 'ai.tag'), 'AI-generated')
    assert.equal(get(h, 'ai.helpful'), 'Student feedback: Yes, this solved my issue')
    assert.equal(get(h, 'ai.notHelpful'), 'Student feedback: No, I still submit to support team')
  })

  test('v3 §2 rating wording: "评分 n/5 / Rating n/5", "未评分 / Not rated"', () => {
    assert.equal(get(enGB.helpDesk, 'rating.value'), 'Rating {n}/5')
    assert.equal(get(enGB.helpDesk, 'rating.none'), 'Not rated')
    assert.equal(get(zhCN.helpDesk, 'rating.value'), '评分 {n}/5')
    assert.equal(get(zhCN.helpDesk, 'rating.none'), '未评分')
  })

  test('Figma 1379:2 / 1379:299 wording (en-GB)', () => {
    const h = enGB.helpDesk as Record<string, unknown>
    assert.equal(get(h, 'faqs.search'), 'Search questions, answers or keywords...')
    assert.equal(get(h, 'faqs.allCategories'), 'All categories')
    assert.equal(get(h, 'faqs.popularFilter.all'), 'All FAQs')
    assert.equal(get(h, 'faqs.count'), '{count} FAQs')
    assert.equal(get(h, 'faqs.columns.question'), 'Question / Answer')
    assert.equal(get(h, 'faqs.columns.category'), 'Category')
    assert.equal(get(h, 'faqs.columns.popular'), 'Popular')
    assert.equal(get(h, 'faqs.columns.updated'), 'Last Updated')
    assert.equal(get(h, 'faqs.columns.action'), 'Action')
    assert.equal(get(h, 'faqs.showing'), 'Showing {from}–{to} of {total} FAQs')
    assert.equal(get(h, 'drawer.editTitle'), 'Edit FAQ')
    assert.equal(get(h, 'drawer.subtitle'), 'Changes update the FAQ shown in Help Centre and used by AI Support.')
    assert.equal(get(h, 'drawer.popular'), 'Popular FAQ')
    assert.equal(get(h, 'drawer.questionEn'), 'Question (English)')
    assert.equal(get(h, 'drawer.answerEn'), 'Answer (English)')
    assert.equal(get(h, 'drawer.questionZh'), 'Question (Chinese)')
    assert.equal(get(h, 'drawer.answerZh'), 'Answer (Chinese)')
    assert.equal(get(h, 'drawer.keywords'), 'Keywords (for search & AI)')
    assert.equal(get(h, 'drawer.save'), 'Save FAQ')
  })

  test('owner-approved zh-CN wording', () => {
    const z = zhCN.helpDesk as Record<string, unknown>
    assert.equal(get(z, 'tabs.enquiries'), '工单')
    assert.equal(get(z, 'tabs.faqs'), '常见问题')
    assert.equal(get(z, 'addFaq'), '新增常见问题')
    assert.equal(get(z, 'claim'), '接单')
    assert.equal(get(z, 'ai.helpful'), '学生反馈：已解决')
    assert.equal(get(z, 'ai.notHelpful'), '学生反馈：仍提交给客服')
  })

  test('zh-CN calls an enquiry 工单 everywhere, as the tab does (the Other Enquiries type keeps its name)', () => {
    const mixed = keys(zhCN.helpDesk)
      .filter((key) => key !== 'category.other')
      .filter((key) => String(get(zhCN.helpDesk, key)).includes('咨询'))
    assert.deepEqual(mixed, [])
    assert.equal(get(zhCN, 'helpDesk.claimHint'), '接手这条工单：分配给你并进入处理中；直接回复也会自动接单。')
    assert.equal(get(zhCN, 'helpDesk.searchPlaceholder'), '搜索学员或工单...')
  })

  test('the four FAQ categories (v2 §1 labels)', () => {
    assert.deepEqual(get(enGB, 'helpDesk.faqCategory'), {
      account_technical: 'Account & Technical Support',
      courses_learning: 'Courses & Learning',
      payments_subscriptions: 'Payments & Subscriptions',
      other: 'Other Enquiries',
    })
    assert.deepEqual(get(zhCN, 'helpDesk.faqCategory'), {
      account_technical: '账户与技术支持',
      courses_learning: '课程与学习',
      payments_subscriptions: '付款与订阅',
      other: '其他问题',
    })
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
      'FAQ_NOT_FOUND',
      'IDEMPOTENCY_KEY_REUSED',
      // v5 question trees and releases (graph design §5)
      'FAQ_EDGE_CYCLE',
      'FAQ_EDGE_EXISTS',
      'FAQ_TOO_MANY_CHILDREN',
      'FAQ_ARCHIVED',
      'FAQ_CHILDREN_CHANGED',
      'FAQ_EDGE_NOT_FOUND',
      'FAQ_TOO_MANY_PHRASINGS',
      'FAQ_HAS_PARENTS',
      'FAQ_KEY_TAKEN',
      'FAQ_RELEASE_NOT_FOUND',
      'FAQ_RELEASE_NOT_READY',
      'FAQ_RELEASE_STALE',
      'FAQ_RELEASE_LOCKED',
      'FAQ_RELEASE_NOT_PUBLISHED',
      'FAQ_RELEASE_CHECKS_FAILED',
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
        // v1 Common Questions is replaced by FAQs (v2 §1)
        'addQuestion',
        'tabs.questions',
        'questions',
        'modal',
        'errors.QUESTION_NOT_FOUND',
      ]) {
        assert.equal(get(h, key), undefined, key)
      }
      assert.equal(typeof get(h, 'filters.needsReply'), 'string')
    }
  })

  test('"FAQ saved." is what + Add FAQ / Save FAQ confirms with', () => {
    assert.equal(get(enGB, 'helpDesk.faqs.saved'), 'FAQ saved.')
    assert.match(read('backoffice/pages/HelpDeskPage.tsx'), /'helpDesk\.faqs\.saved'/)
  })
})

describe('HelpDesk wiring', () => {
  test('the card board, the separate ticket page and the v1 Common Questions UI are removed', () => {
    assert.equal(existsSync(new URL('backoffice/pages/HelpDeskTicketPage.tsx', root)), false)
    for (const file of ['backoffice/helpdesk/QuestionsView.tsx', 'backoffice/helpdesk/QuestionModal.tsx', 'backoffice/lib/helpdeskQuestions.ts']) {
      assert.equal(existsSync(new URL(file, root)), false, file)
    }
    assert.doesNotMatch(read('backoffice/lib/helpdeskApi.ts'), /\/api\/helpdesk\/questions/)
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
      'backoffice/lib/helpdeskFaqs.ts',
      'backoffice/lib/helpdeskMarkdown.ts',
    ].map(read)
    for (const source of sources) assert.doesNotMatch(source, /analytics|gtag|track\(|sendBeacon|traceparent/i)
  })
})

describe('v5 Part G wording (FAQ 候选 / HelpDesk 数据, 待视觉验收)', () => {
  test('the spec names: the FAQ 候选 and HelpDesk 数据 tabs, 转成 FAQ 候选, 草稿 待核实', () => {
    assert.equal(get(zhCN.helpDesk, 'tabs.candidates'), 'FAQ 候选')
    assert.equal(get(zhCN.helpDesk, 'tabs.data'), 'HelpDesk 数据')
    assert.equal(get(zhCN.helpDesk, 'actions.toCandidate'), '转成 FAQ 候选')
    assert.equal(get(zhCN.helpDesk, 'drawer.draft.title'), '草稿 待核实')
    assert.equal(get(enGB.helpDesk, 'tabs.candidates'), 'FAQ candidates')
    assert.equal(get(enGB.helpDesk, 'tabs.data'), 'HelpDesk data')
    assert.equal(get(enGB.helpDesk, 'drawer.draft.title'), 'Draft, to be verified')
  })

  test('every enum the flywheel pages show has a label in both languages', () => {
    const groups: [string, readonly string[]][] = [
      ['candidates.status', ['new', 'accepted', 'dismissed', 'merged']],
      ['candidates.suggestion', ['new_faq', 'add_phrasing', 'follow_up']],
      ['candidates.origin', ['mining', 'ticket']],
      ['candidates.reasons', ['duplicate', 'not_a_gap', 'out_of_scope', 'personal_data', 'spam', 'other']],
      ['candidates.mix', ['no_match', 'not_helpful', 'clarify_not_covered', 'handover', 'ticket_after_chat', 'low_rating', 'ticket']],
      ['candidates.revision', ['create', 'grow', 'accept', 'dismiss', 'merge']],
      ['data.metrics', ['aiSolvedRate', 'noMatchRate', 'helpfulRate', 'avgRating', 'handoverRate', 'clarifyCoveredRate', 'guardFallbackRate']],
      ['data.splits', ['none', 'locale', 'entry', 'signal']],
      ['data.entry', ['submit', 'chat', 'chip']],
    ]
    for (const bundle of [enGB, zhCN])
      for (const [group, values] of groups)
        for (const value of values) assert.equal(typeof get(bundle.helpDesk, `${group}.${value}`), 'string', `${group}.${value}`)
  })

  test('the flywheel error codes have messages', () => {
    for (const code of [
      'CANDIDATE_NOT_FOUND',
      'CANDIDATE_CHANGED',
      'CANDIDATE_CLOSED',
      'TICKET_NOT_RESOLVED',
      'TICKET_NO_QUESTION',
      'JOB_ALREADY_RUNNING',
      'JOB_START_FAILED',
      'JOB_NOT_FOUND',
      'JOB_RUN_NOT_FOUND',
    ])
      for (const bundle of [enGB, zhCN]) assert.equal(typeof get(bundle, `helpDesk.errors.${code}`), 'string', code)
  })
})
