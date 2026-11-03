import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import type { FaqChange } from '../src/backoffice/contracts/helpdesk'
import {
  DEFAULT_CHANGE_FILTERS,
  actionTone,
  changeLogHref,
  changeQuery,
  changeSummary,
  changeTitle,
  fieldValue,
  learnersLine,
  listDiff,
  ordinal,
  personName,
  personRole,
  rangeStart,
  readChangeFilters,
  textDiff,
  writeChangeFilters,
} from '../src/backoffice/lib/helpdeskChanges'

/**
 * Change Log 的纯逻辑（helpdeskChanges.ts，Figma 草案 2.6–2.9）：地址栏筛选、查询串（时间段按本地零点）、
 * 每一行的标题与摘要、字段显示值、列表加减、长文字改了哪一段、「用户是否已看到」。
 */

const FAQ_ID = '0192aaaa-0000-7000-8000-0000000000f1'
const EMP = '0192aaaa-0000-7000-8000-0000000000e1'

function change(patch: Partial<FaqChange> = {}): FaqChange {
  return {
    id: 'faq:1',
    at: '2026-10-30T08:20:05.000Z',
    employee: { id: EMP, name: 'jack', role: 'ADMIN', email: 'jack@example.com' },
    subject: 'faq',
    action: 'edited',
    faq: { id: FAQ_ID, key: 'reset-password', questionEn: 'How do I reset my password?', questionZh: '如何重置密码？', status: 'published' },
    child: null,
    phrasing: null,
    release: null,
    version: { from: 4, to: 5 },
    changes: [],
    learners: 'pending',
    liveIn: null,
    ...patch,
  }
}

describe('Change Log filters in the address bar', () => {
  test('defaults to the last 30 days; unknown or malformed values fall back', () => {
    assert.deepEqual(readChangeFilters(new URLSearchParams('')), DEFAULT_CHANGE_FILTERS)
    assert.deepEqual(readChangeFilters(new URLSearchParams('by=jack&type=everything&range=1y&faq=x&page=-2')), DEFAULT_CHANGE_FILTERS)
    assert.deepEqual(
      readChangeFilters(new URLSearchParams(`q=+refund+&by=${EMP.toUpperCase()}&type=phrasing&range=all&faq=${FAQ_ID}&page=3`)),
      { q: 'refund', by: EMP, type: 'phrasing', range: 'all', faq: FAQ_ID, page: 3 },
    )
    assert.equal(readChangeFilters(new URLSearchParams('by=system')).by, 'system')
    assert.equal(readChangeFilters(new URLSearchParams(`q=${'x'.repeat(300)}`)).q.length, 200)
  })

  test('writing drops defaults and keeps other parameters (tab)', () => {
    const next = writeChangeFilters(new URLSearchParams('tab=changes&page=4'), { type: 'release', range: '30d', page: 1, by: 'all' })
    assert.equal(next.toString(), 'tab=changes&type=release')
  })

  test('Open in Change Log: all time, only that FAQ', () => {
    assert.equal(changeLogHref('en-GB', FAQ_ID), `/en-GB/help-desk?tab=changes&range=all&faq=${FAQ_ID}`)
  })
})

describe('Change Log request', () => {
  test('ranges start at local midnight; all time sends no start', () => {
    const now = new Date(2026, 9, 30, 15, 45)
    assert.equal(rangeStart('all', now), null)
    assert.equal(rangeStart('today', now)?.getTime(), new Date(2026, 9, 30).getTime())
    assert.equal(rangeStart('7d', now)?.getTime(), new Date(2026, 9, 24).getTime())
    assert.equal(rangeStart('30d', now)?.getTime(), new Date(2026, 9, 1).getTime())
    assert.equal(rangeStart('90d', now)?.getTime(), new Date(2026, 7, 2).getTime())
  })

  test('maps the filters to the server parameters', () => {
    const now = new Date(2026, 9, 30, 15, 45)
    const query = new URLSearchParams(
      changeQuery({ q: ' refund ', by: 'system', type: 'follow_up', range: 'today', faq: FAQ_ID, page: 2 }, now),
    )
    assert.deepEqual(Object.fromEntries(query), {
      subject: 'follow_up',
      employee: 'system',
      faq: FAQ_ID,
      from: new Date(2026, 9, 30).toISOString(),
      q: 'refund',
      page: '2',
      pageSize: '10',
    })
    assert.deepEqual(Object.fromEntries(new URLSearchParams(changeQuery({ ...DEFAULT_CHANGE_FILTERS, range: 'all' }, now))), {
      page: '1',
      pageSize: '10',
    })
  })
})

describe('rows: title, summary, people', () => {
  test('a FAQ edit lists the fields; a create shows category and popular; a delete says where it went', () => {
    const edit = change({ changes: [{ field: 'answerEn', before: 'a', after: 'b' }, { field: 'keywords', before: [], after: ['x'] }] })
    assert.equal(changeTitle('en-GB', edit), 'How do I reset my password?')
    assert.equal(changeTitle('zh-CN', edit), '如何重置密码？')
    assert.equal(changeSummary('en-GB', edit), 'Answer (English) · Keywords')
    assert.equal(changeSummary('zh-CN', edit), '答案（英文） · 关键词')
    assert.equal(
      changeSummary('en-GB', change({ action: 'created', changes: [{ field: 'category', before: null, after: 'courses_learning' }, { field: 'popular', before: null, after: true }] })),
      'Courses & Learning · Popular',
    )
    assert.equal(changeSummary('en-GB', change({ action: 'archived' })), 'Removed from Help Centre and AI Support')
  })

  test('links: parent → child; added at a position, moved, custom text, removed', () => {
    const child = { id: 'c', key: 'no-email', questionEn: 'I did not get the reset email', questionZh: '没收到邮件', status: 'published' as const }
    const link = (patch: Partial<FaqChange>) => change({ subject: 'follow_up', child, version: null, ...patch })
    assert.equal(changeTitle('en-GB', link({})), 'How do I reset my password? → I did not get the reset email')
    assert.equal(changeSummary('en-GB', link({ action: 'added', changes: [{ field: 'position', before: null, after: 1 }] })), 'Shown 2nd')
    assert.equal(changeSummary('en-GB', link({ action: 'reordered', changes: [{ field: 'position', before: 2, after: 0 }] })), 'Moved 3rd → 1st')
    assert.equal(changeSummary('zh-CN', link({ action: 'reordered', changes: [{ field: 'position', before: 2, after: 0 }] })), '从第 3 个移到第 1 个')
    assert.equal(
      changeSummary('en-GB', link({ action: 'changed', changes: [{ field: 'labelEn', before: null, after: 'Didn’t get the email?' }] })),
      'Custom text: Didn’t get the email?',
    )
    assert.equal(changeSummary('en-GB', link({ action: 'changed', changes: [{ field: 'labelEn', before: 'x', after: null }] })), 'Shows the question itself')
    assert.equal(changeSummary('en-GB', link({ action: 'removed' })), 'No longer shown after this card')
  })

  test('phrasings and releases', () => {
    assert.equal(
      changeSummary('en-GB', change({ subject: 'phrasing', action: 'removed', phrasing: { locale: 'zh-CN', text: '忘记密码怎么办', source: 'staff' } })),
      '“忘记密码怎么办” (Simplified Chinese)',
    )
    const release = (action: FaqChange['action'], patch: Partial<NonNullable<FaqChange['release']>> = {}) =>
      change({ subject: 'release', action, faq: null, version: null, learners: null, release: { version: 12, status: 'published', sourceVersion: null, problems: 0, ...patch } })
    assert.equal(changeTitle('en-GB', release('published')), 'Version 12')
    assert.equal(changeSummary('en-GB', release('published')), 'Learners now see version 12')
    assert.equal(changeSummary('en-GB', release('version_created')), 'Checks passed')
    assert.equal(changeSummary('en-GB', release('version_created', { problems: 3 })), '3 problems found')
    assert.equal(changeSummary('en-GB', release('rolled_back', { sourceVersion: 9 })), 'Copy of version 9, published straight away')
  })

  test('who: name and role; system writes; an account that is gone', () => {
    assert.equal(personName('en-GB', change()), 'jack')
    assert.equal(personRole('en-GB', change()), 'Admin')
    assert.equal(personName('en-GB', change({ employee: null })), 'System')
    assert.equal(personRole('en-GB', change({ employee: null })), 'Seed or automatic')
    assert.equal(personName('zh-CN', change({ employee: { id: EMP, name: '', role: null, email: null } })), '已不在的员工')
  })

  test('the colour of each action', () => {
    assert.equal(actionTone({ action: 'created' }), 'green')
    assert.equal(actionTone({ action: 'reordered' }), 'blue')
    assert.equal(actionTone({ action: 'archived' }), 'red')
    assert.equal(actionTone({ action: 'published' }), 'purple')
    assert.equal(actionTone({ action: 'version_created' }), 'neutral')
  })
})

describe('values and diffs', () => {
  test('ordinals', () => {
    assert.deepEqual([0, 1, 2, 3, 10, 11, 20, 21].map((p) => ordinal('en-GB', p)), ['1st', '2nd', '3rd', '4th', '11th', '12th', '21st', '22nd'])
    assert.equal(ordinal('zh-CN', 1), '第 2 个')
  })

  test('field values read like the editor', () => {
    assert.equal(fieldValue('en-GB', 'category', 'payments_subscriptions'), 'Payments & Subscriptions')
    assert.equal(fieldValue('en-GB', 'popular', false), 'No')
    assert.equal(fieldValue('en-GB', 'type', 'choice'), 'Choice question (A/B/C/D)')
    assert.equal(fieldValue('en-GB', 'status', 'archived'), 'Deleted')
    assert.equal(fieldValue('en-GB', 'signals', ['payment_failed']), 'Payment failed')
    assert.equal(fieldValue('en-GB', 'labelEn', null), '(empty)')
  })

  test('lists: kept, removed, added', () => {
    assert.deepEqual(listDiff(['reset password', 'cannot log in'], ['reset password', 'reset link', 'link expired']), {
      kept: ['reset password'],
      removed: ['cannot log in'],
      added: ['reset link', 'link expired'],
    })
    assert.deepEqual(listDiff(null, ['a']), { kept: [], removed: [], added: ['a'] })
  })

  test('long text: only the changed stretch is marked, cut at word or sentence boundaries', () => {
    const before = 'Select “Forgot password”. If no email arrives, check your spam folder.'
    const after = 'Select “Forgot password”. The link expires after 30 minutes; check your spam folder.'
    const diff = textDiff(before, after)
    assert.equal(diff.before.map((p) => p.text).join(''), before)
    assert.equal(diff.after.map((p) => p.text).join(''), after)
    assert.deepEqual(
      diff.before.filter((p) => p.changed).map((p) => p.text),
      ['If no email arrives,'],
    )
    assert.deepEqual(
      diff.after.filter((p) => p.changed).map((p) => p.text),
      ['The link expires after 30 minutes;'],
    )
    assert.deepEqual(textDiff('same', 'same').after, [{ text: 'same', changed: false }])
    // 全新（改前为空）：整段都是加上的
    assert.deepEqual(textDiff('', 'new text').after, [{ text: 'new text', changed: true }])
  })

  test('do learners see it', () => {
    assert.deepEqual(learnersLine('en-GB', { learners: 'pending', liveIn: null }), {
      state: 'pending',
      hint: 'Goes live with the next published release',
    })
    assert.deepEqual(learnersLine('en-GB', { learners: 'live', liveIn: 12 }), { state: 'live', hint: 'Live since version 12' })
    assert.equal(learnersLine('en-GB', { learners: 'live', liveIn: null })?.hint, 'Live as soon as it was saved (no release published yet)')
    assert.match(learnersLine('en-GB', { learners: 'pending', liveIn: 3 })?.hint ?? '', /rollback/)
    assert.equal(learnersLine('en-GB', { learners: null, liveIn: null }), null)
  })
})
