import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AVATAR_PALETTE,
  TAG_PALETTE,
  activeFilterCount,
  applyDetailToRow,
  avatarColor,
  dayLabel,
  enquiryControls,
  enquiryQuery,
  fileSize,
  initials,
  listTime,
  mergeTickets,
  normalizeTag,
  readEnquiryFilters,
  shouldMarkRead,
  splitThread,
  subscriptionTone,
  tagAddError,
  tagColor,
  writeEnquiryFilters,
} from '../src/backoffice/lib/helpdeskView'

/** Figma 1324:2 的 8 组头像底色 / 字色与 3 组标签色。 */
const FIGMA_AVATARS = [
  ['#dbeafe', '#146eff'],
  ['#dcfce7', '#16a34a'],
  ['#fef3c7', '#d97706'],
  ['#f3e8ff', '#9333ea'],
  ['#fee2e2', '#dc2626'],
  ['#e0f2fe', '#0284c7'],
  ['#fff7ed', '#ea580c'],
  ['#f0fdf4', '#16a34a'],
]

const NOW = new Date('2026-10-28T15:00:00Z')

function message(
  id: string,
  authorKind: 'learner' | 'agent' | 'system',
  internal = false,
): {
  id: string
  authorKind: 'learner' | 'agent' | 'system'
  authorName: string
  body: string
  internal: boolean
  attachments: never[]
  createdAt: string
} {
  return { id, authorKind, authorName: id, body: id, internal, attachments: [], createdAt: '2026-10-28T10:00:00Z' }
}

const AVAILABLE_ALL = {
  claim: true,
  reply: true,
  internalNote: true,
  proposeResolution: true,
  tag: true,
  markRead: true,
}

describe('avatar and tag colours (Figma 1324:2)', () => {
  test('the avatar palette is exactly the Figma one', () => {
    assert.deepEqual(
      AVATAR_PALETTE.map((c) => [c.bg, c.fg]),
      FIGMA_AVATARS,
    )
  })

  test('the same learner id always gets the same colour, and ids spread over the palette', () => {
    assert.deepEqual(avatarColor('learner-1'), avatarColor('learner-1'))
    const used = new Set(Array.from({ length: 64 }, (_, i) => avatarColor(`learner-${i}`).bg))
    assert.ok(used.size >= 6, `only ${used.size} colours used`)
    for (const colour of used) assert.ok(FIGMA_AVATARS.some(([bg]) => bg === colour))
  })

  test('tag colours are exactly the three Figma tag colours and are stable, case-insensitively', () => {
    assert.deepEqual(TAG_PALETTE.map((c) => [c.bg, c.fg]), [
      ['#eff6ff', '#146eff'],
      ['#fff7ed', '#ea580c'],
      ['#f0fdf4', '#16a34a'],
    ])
    assert.deepEqual(tagColor('login issue'), tagColor('Login Issue'))
    assert.deepEqual(tagColor(' payment '), tagColor('payment'))
    assert.ok(TAG_PALETTE.some((c) => c.bg === tagColor('anything').bg))
  })
})

describe('initials', () => {
  test('two words give two letters', () => {
    assert.equal(initials('Emily Carter'), 'EC')
    assert.equal(initials('  daniel   wu '), 'DW')
    assert.equal(initials('Mary Ann Lee'), 'ML')
  })
  test('one word gives one letter; CJK names give the first character', () => {
    assert.equal(initials('Sophia'), 'S')
    assert.equal(initials('王小明'), '王')
  })
  test('falls back to the email, then to ?', () => {
    assert.equal(initials('', 'olivia@example.com'), 'O')
    assert.equal(initials('', ''), '?')
  })
})

describe('list time ("HH:mm" today, else "16 May")', () => {
  test('today shows 24-hour time', () => {
    assert.equal(listTime('2026-10-28T14:32:00Z', 'en-GB', NOW), '14:32')
    assert.equal(listTime('2026-10-28T09:05:00Z', 'zh-CN', NOW), '09:05')
  })
  test('earlier this year shows day and short month', () => {
    assert.equal(listTime('2026-05-16T10:00:00Z', 'en-GB', NOW), '16 May')
    assert.equal(listTime('2026-05-16T10:00:00Z', 'zh-CN', NOW), '5月16日')
  })
  test('another year adds the year', () => {
    assert.equal(listTime('2025-04-16T10:00:00Z', 'en-GB', NOW), '16 Apr 2025')
  })
  test('missing or bad times show nothing', () => {
    assert.equal(listTime(null, 'en-GB', NOW), '')
    assert.equal(listTime('not a date', 'en-GB', NOW), '')
  })
})

describe('date separator', () => {
  test('today / yesterday / a full date', () => {
    assert.deepEqual(dayLabel('2026-10-28T01:00:00Z', 'en-GB', NOW), { kind: 'today' })
    assert.deepEqual(dayLabel('2026-10-27T23:00:00Z', 'en-GB', NOW), { kind: 'yesterday' })
    assert.deepEqual(dayLabel('2026-05-16T10:00:00Z', 'en-GB', NOW), { kind: 'date', text: '16 May 2026' })
    assert.deepEqual(dayLabel('2026-05-16T10:00:00Z', 'zh-CN', NOW), { kind: 'date', text: '2026年5月16日' })
  })
})

describe('file size (attachment chip "245 KB")', () => {
  test('bytes, KB and MB', () => {
    assert.equal(fileSize(512), '512 B')
    assert.equal(fileSize(245 * 1024), '245 KB')
    assert.equal(fileSize(1536), '2 KB')
    assert.equal(fileSize(3.5 * 1024 * 1024), '3.5 MB')
    assert.equal(fileSize(-1), '')
  })
})

describe('list paging and unread', () => {
  const a = { id: 'a', unreadByAgent: true }
  const b = { id: 'b', unreadByAgent: false }
  const c = { id: 'c', unreadByAgent: true }

  test('loading more appends new rows and replaces duplicates in place', () => {
    const merged = mergeTickets([a, b], [{ ...b, unreadByAgent: true }, c])
    assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c'])
    assert.equal(merged[1].unreadByAgent, true)
  })

  test('after a write the list row takes the new status, tags, unread flag and sequence', () => {
    const row = {
      id: 'a',
      subject: 'old',
      status: 'OPEN',
      tags: [] as string[],
      unreadByAgent: true,
      needsReply: true,
      sequence: 1,
      preview: 'p',
    }
    const other = { ...row, id: 'b' }
    const detail = {
      ...row,
      status: 'WAITING_USER',
      tags: ['vip'],
      unreadByAgent: false,
      needsReply: false,
      sequence: 4,
      messages: [{ id: 'm' }],
    }
    const [updated, untouched] = applyDetailToRow([row, other], detail)
    assert.equal(updated.status, 'WAITING_USER')
    assert.deepEqual(updated.tags, ['vip'])
    assert.equal(updated.unreadByAgent, false)
    assert.equal(updated.needsReply, false)
    assert.equal(updated.sequence, 4)
    assert.equal('messages' in updated, false)
    assert.equal(untouched, other)
  })

  test('opening a ticket marks it read only for FULL roles, only when unread and allowed', () => {
    const ticket = { unreadByAgent: true, available: { ...AVAILABLE_ALL } }
    assert.equal(shouldMarkRead(ticket, true), true)
    assert.equal(shouldMarkRead(ticket, false), false)
    assert.equal(shouldMarkRead({ ...ticket, unreadByAgent: false }, true), false)
    assert.equal(shouldMarkRead({ ...ticket, available: { ...AVAILABLE_ALL, markRead: false } }, true), false)
  })
})

describe('write controls (VIEW sees none)', () => {
  test('FULL sees what the server allows', () => {
    assert.deepEqual(enquiryControls({ available: AVAILABLE_ALL }, true), {
      markReviewed: true,
      composer: true,
      reply: true,
      internalNote: true,
      editTags: true,
    })
    assert.deepEqual(
      enquiryControls(
        { available: { ...AVAILABLE_ALL, reply: false, proposeResolution: false, tag: false } },
        true,
      ),
      { markReviewed: false, composer: true, reply: false, internalNote: true, editTags: false },
    )
  })

  test('VIEW sees no write controls at all, whatever the server says', () => {
    assert.deepEqual(enquiryControls({ available: AVAILABLE_ALL }, false), {
      markReviewed: false,
      composer: false,
      reply: false,
      internalNote: false,
      editTags: false,
    })
  })
})

describe('thread split (enquiry card + later messages)', () => {
  test('the first public learner message is the enquiry card; the rest follow in order', () => {
    const messages = [message('n1', 'agent', true), message('m1', 'learner'), message('r1', 'agent'), message('m2', 'learner')]
    const { enquiry, rest } = splitThread(messages)
    assert.equal(enquiry?.id, 'm1')
    assert.deepEqual(rest.map((m) => m.id), ['n1', 'r1', 'm2'])
  })
  test('no learner message → no enquiry card', () => {
    const { enquiry, rest } = splitThread([message('s', 'system')])
    assert.equal(enquiry, null)
    assert.equal(rest.length, 1)
  })
})

describe('tags', () => {
  test('normalizeTag trims, collapses spaces and rejects bad input', () => {
    assert.equal(normalizeTag('  login   issue '), 'login issue')
    assert.equal(normalizeTag(''), null)
    assert.equal(normalizeTag('   '), null)
    assert.equal(normalizeTag('x'.repeat(33)), null)
    assert.equal(normalizeTag('x'.repeat(32)), 'x'.repeat(32))
    assert.equal(normalizeTag('bad\u0007tag'), null)
  })
  test('tagAddError: invalid, duplicate (case-insensitive) and the 10-tag limit', () => {
    assert.equal(tagAddError(['payment'], 'refund'), null)
    assert.equal(tagAddError(['payment'], ' '), 'invalid')
    assert.equal(tagAddError(['payment'], 'Payment'), 'duplicate')
    assert.equal(tagAddError(Array.from({ length: 10 }, (_, i) => `t${i}`), 'new'), 'limit')
  })
})

describe('enquiry filters in the address bar', () => {
  test('reads valid values and drops unknown ones', () => {
    const params = new URLSearchParams('q=%20login%20&status=needs_reply&category=course_content&tag=vip')
    assert.deepEqual(readEnquiryFilters(params), {
      q: 'login',
      status: 'needs_reply',
      category: 'course_content',
      tag: 'vip',
    })
    assert.deepEqual(readEnquiryFilters(new URLSearchParams('status=BOGUS&category=billing')), {
      q: '',
      status: 'all',
      category: 'all',
      tag: '',
    })
  })

  test('writes only non-default values and keeps other params', () => {
    const params = writeEnquiryFilters(new URLSearchParams('tab=enquiries&status=OPEN'), {
      status: 'all',
      q: 'refund',
    })
    assert.equal(params.get('tab'), 'enquiries')
    assert.equal(params.get('status'), null)
    assert.equal(params.get('q'), 'refund')
  })

  test('API query: defaults left out, q capped at 120, cursor and limit passed', () => {
    assert.equal(enquiryQuery({ q: '', status: 'all', category: 'all', tag: '' }), 'limit=30')
    const query = new URLSearchParams(
      enquiryQuery({ q: 'x'.repeat(130), status: 'OPEN', category: 'other', tag: 'vip' }, 'cur-1'),
    )
    assert.equal(query.get('q'), 'x'.repeat(120))
    assert.equal(query.get('status'), 'OPEN')
    assert.equal(query.get('category'), 'other')
    assert.equal(query.get('tag'), 'vip')
    assert.equal(query.get('cursor'), 'cur-1')
    assert.equal(query.get('limit'), '30')
  })

  test('active filter count ignores the search box', () => {
    assert.equal(activeFilterCount({ q: 'x', status: 'all', category: 'all', tag: '' }), 0)
    assert.equal(activeFilterCount({ q: '', status: 'OPEN', category: 'other', tag: 'vip' }), 3)
  })
})

describe('subscription status pill', () => {
  test('active is green, payment trouble amber, anything else neutral', () => {
    assert.equal(subscriptionTone('active'), 'success')
    assert.equal(subscriptionTone('ACTIVE'), 'success')
    assert.equal(subscriptionTone('trialing'), 'success')
    assert.equal(subscriptionTone('past_due'), 'warning')
    assert.equal(subscriptionTone('cancelled'), 'neutral')
  })
})
