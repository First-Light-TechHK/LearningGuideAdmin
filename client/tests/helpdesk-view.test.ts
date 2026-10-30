import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AVATAR_PALETTE,
  TAG_PALETTE,
  TIMELINE_AVATAR,
  enquiryTypeColor,
  activeFilterCount,
  applyDetailToRow,
  assistFeedbackTone,
  avatarColor,
  cardTime,
  dayLabel,
  claimInput,
  flagInput,
  groupByDay,
  splitNotes,
  timelineCards,
  enquiryControls,
  enquiryQuery,
  fileSize,
  initials,
  listTime,
  markReadInput,
  mergeTickets,
  normalizeTag,
  ratingValue,
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
  flag: true,
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

  test('tag colours are exactly the three Figma tag colours, in the Figma order by position (blue, orange, green, blue)', () => {
    assert.deepEqual(TAG_PALETTE.map((c) => [c.bg, c.fg]), [
      ['#eff6ff', '#146eff'],
      ['#fff7ed', '#ea580c'],
      ['#f0fdf4', '#16a34a'],
    ])
    // Figma 1324:2: login issue blue, account access orange, payment green, material access blue
    assert.deepEqual([0, 1, 2, 3].map((index) => tagColor(index).fg), ['#146eff', '#ea580c', '#16a34a', '#146eff'])
    assert.deepEqual(tagColor(-1), TAG_PALETTE[2])
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
      flagged: false,
      available: { ...AVAILABLE_ALL, proposeResolution: false },
    }
    const other = { ...row, id: 'b' }
    const detail = {
      ...row,
      status: 'WAITING_USER',
      tags: ['vip'],
      unreadByAgent: false,
      needsReply: false,
      sequence: 4,
      flagged: true,
      available: { ...AVAILABLE_ALL },
      messages: [{ id: 'm' }],
    }
    const [updated, untouched] = applyDetailToRow([row, other], detail)
    assert.equal(updated.flagged, true, 'the row flag icon follows a flag toggle')
    assert.equal(updated.available.proposeResolution, true, 'the card action bar follows the new state')
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

  test('mark_read carries the sequence the agent saw, so a newer learner message stays unread', () => {
    assert.deepEqual(markReadInput({ sequence: 7 }), { action: 'mark_read', expectedSequence: 7 })
  })
})

describe('write controls (VIEW sees none)', () => {
  test('FULL sees what the server allows', () => {
    assert.deepEqual(enquiryControls({ available: AVAILABLE_ALL }, true), {
      actionBar: true,
      claim: true,
      markReviewed: true,
      composer: true,
      reply: true,
      internalNote: true,
      editTags: true,
      flag: true,
    })
    assert.deepEqual(
      enquiryControls(
        { available: { ...AVAILABLE_ALL, reply: false, proposeResolution: false, tag: false, flag: false } },
        true,
      ),
      {
        actionBar: true,
        claim: true,
        markReviewed: false,
        composer: true,
        reply: false,
        internalNote: true,
        editTags: false,
        flag: false,
      },
    )
  })

  test('a brand-new OPEN enquiry can be claimed (Mark as reviewed needs ASSIGNED or WAITING_USER)', () => {
    // What the server returns for OPEN (availableActions in the Admin server, spec §2 state table).
    const open = { claim: true, reply: true, internalNote: true, proposeResolution: false, tag: true, markRead: true, flag: true }
    const controls = enquiryControls({ available: open }, true)
    assert.equal(controls.claim, true)
    assert.equal(controls.markReviewed, false)
    const assigned = enquiryControls({ available: { ...open, claim: false, proposeResolution: true } }, true)
    assert.equal(assigned.claim, false)
    assert.equal(assigned.markReviewed, true)
    assert.equal(enquiryControls({ available: open }, false).claim, false, 'VIEW cannot claim')
  })

  test('claim is sent with the sequence on screen (stale -> 409, reload)', () => {
    assert.deepEqual(claimInput({ sequence: 1 }), { action: 'claim', expectedSequence: 1 })
  })

  test('VIEW sees no write controls at all, whatever the server says', () => {
    assert.deepEqual(enquiryControls({ available: AVAILABLE_ALL }, false), {
      actionBar: false,
      claim: false,
      markReviewed: false,
      composer: false,
      reply: false,
      internalNote: false,
      editTags: false,
      flag: false,
    })
  })

  test('Flag follow-up toggles: flag when not flagged, unflag when flagged, with the sequence on screen', () => {
    assert.deepEqual(flagInput({ flagged: false, sequence: 5 }), { action: 'flag', expectedSequence: 5 })
    assert.deepEqual(flagInput({ flagged: true, sequence: 6 }), { action: 'unflag', expectedSequence: 6 })
  })
})

describe('student timeline (Figma 1324:2 middle column)', () => {
  const card = (id: string, learner: string, createdAt: string) => ({ id, learner: { id: learner }, createdAt })

  test("the selected enquiry plus that learner's others, newest first, max 10 plus the selected", () => {
    const selected = card('s', 'u1', '2026-10-20T09:00:00Z')
    const rows = [
      card('a', 'u1', '2026-10-28T09:00:00Z'),
      card('s', 'u1', '2026-10-20T09:00:00Z'),
      card('x', 'u2', '2026-10-27T09:00:00Z'),
      card('b', 'u1', '2026-10-25T09:00:00Z'),
    ]
    assert.deepEqual(
      timelineCards(selected, rows).map((c) => c.id),
      ['a', 'b', 's'],
      "another learner's enquiry never shows; the selected one is not repeated",
    )
    const many = Array.from({ length: 12 }, (_, i) => card(`m${i}`, 'u1', `2026-10-${String(i + 10).padStart(2, '0')}T09:00:00Z`))
    const old = card('old', 'u1', '2026-01-01T00:00:00Z')
    const ids = timelineCards(old, many).map((c) => c.id)
    assert.equal(ids.length, 11)
    assert.equal(ids[0], 'm11')
    assert.equal(ids.at(-1), 'old', 'the selected enquiry is always there even when older than the 10 newest')
  })

  test('grouped under "28 Oct 2026" date separators; card times are HH:mm', () => {
    const groups = groupByDay(
      [card('a', 'u', '2026-10-28T14:32:00'), card('b', 'u', '2026-10-28T09:05:00'), card('c', 'u', '2026-10-20T10:00:00')],
      'en-GB',
    )
    assert.deepEqual(
      groups.map((g) => [g.label, g.cards.map((c) => c.id)]),
      [
        ['28 Oct 2026', ['a', 'b']],
        ['20 Oct 2026', ['c']],
      ],
    )
    assert.equal(groupByDay([card('a', 'u', '2026-10-28T14:32:00')], 'zh-CN')[0].label, '2026年10月28日')
    assert.equal(cardTime('2026-10-28T14:32:00', 'en-GB'), '14:32')
    assert.equal(cardTime('2026-10-28T09:05:00', 'zh-CN'), '09:05')
    assert.equal(cardTime(null, 'en-GB'), '')
  })

  test('internal notes live in the Internal notes panel, the rest is the conversation', () => {
    const { notes, conversation } = splitNotes([message('r1', 'agent'), message('n1', 'agent', true), message('s1', 'system')])
    assert.deepEqual(notes.map((m) => m.id), ['n1'])
    assert.deepEqual(conversation.map((m) => m.id), ['r1', 's1'])
  })

  test('AI block feedback line: helpful / solved green, not helpful / declined red, otherwise none', () => {
    assert.equal(assistFeedbackTone('helpful'), 'positive')
    assert.equal(assistFeedbackTone('solved'), 'positive')
    assert.equal(assistFeedbackTone('not_helpful'), 'negative')
    assert.equal(assistFeedbackTone('declined'), 'negative')
    assert.equal(assistFeedbackTone('edited'), null)
    assert.equal(assistFeedbackTone(null), null)
  })

  test('v3 §2 rating: only an integer 1-5 counts, anything else is no rating', () => {
    for (const n of [1, 2, 3, 4, 5]) assert.equal(ratingValue(n), n)
    for (const bad of [0, 6, 3.5, -1, Number.NaN, '4', null, undefined, {}]) assert.equal(ratingValue(bad), null, String(bad))
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
      flagged: false,
    })
    assert.deepEqual(readEnquiryFilters(new URLSearchParams('status=BOGUS&category=billing&flagged=yes')), {
      q: '',
      status: 'all',
      category: 'all',
      tag: '',
      flagged: false,
    })
    assert.equal(readEnquiryFilters(new URLSearchParams('flagged=true')).flagged, true)
  })

  test('writes only non-default values and keeps other params', () => {
    const params = writeEnquiryFilters(new URLSearchParams('tab=enquiries&status=OPEN'), {
      status: 'all',
      q: 'refund',
    })
    assert.equal(params.get('tab'), 'enquiries')
    assert.equal(params.get('status'), null)
    assert.equal(params.get('q'), 'refund')
    assert.equal(writeEnquiryFilters(params, { flagged: true }).get('flagged'), 'true')
    assert.equal(writeEnquiryFilters(new URLSearchParams('flagged=true'), { flagged: false }).has('flagged'), false)
  })

  test('the literal word "all" is a real search or tag, only status / category use it as the default', () => {
    const params = writeEnquiryFilters(new URLSearchParams('status=OPEN&category=other'), {
      q: 'all',
      tag: 'all',
      status: 'all',
      category: 'all',
    })
    assert.equal(params.get('q'), 'all')
    assert.equal(params.get('tag'), 'all')
    assert.equal(params.get('status'), null)
    assert.equal(params.get('category'), null)
    assert.deepEqual(readEnquiryFilters(params), { q: 'all', status: 'all', category: 'all', tag: 'all', flagged: false })
    const cleared = writeEnquiryFilters(params, { q: '  ', tag: '' })
    assert.equal(cleared.has('q'), false)
    assert.equal(cleared.has('tag'), false)
  })

  test('API query: defaults left out, q capped at 120, cursor and limit passed', () => {
    assert.equal(enquiryQuery({ q: '', status: 'all', category: 'all', tag: '', flagged: false }), 'limit=30')
    const query = new URLSearchParams(
      enquiryQuery({ q: 'x'.repeat(130), status: 'OPEN', category: 'other', tag: 'vip', flagged: true }, 'cur-1'),
    )
    assert.equal(query.get('flagged'), 'true')
    assert.equal(query.get('q'), 'x'.repeat(120))
    assert.equal(query.get('status'), 'OPEN')
    assert.equal(query.get('category'), 'other')
    assert.equal(query.get('tag'), 'vip')
    assert.equal(query.get('cursor'), 'cur-1')
    assert.equal(query.get('limit'), '30')
  })

  test('active filter count ignores the search box', () => {
    assert.equal(activeFilterCount({ q: 'x', status: 'all', category: 'all', tag: '', flagged: false }), 0)
    assert.equal(activeFilterCount({ q: '', status: 'OPEN', category: 'other', tag: 'vip', flagged: false }), 3)
    assert.equal(activeFilterCount({ q: '', status: 'all', category: 'all', tag: '', flagged: true }), 1)
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

describe('timeline card colours (Figma 1324:2 v2)', () => {
  test('the avatar outside each card is #ddebff / #1d63d6', () => {
    assert.deepEqual(TIMELINE_AVATAR, { bg: '#ddebff', fg: '#1d63d6' })
  })

  test('type tag: Technical Support blue, Payments & Subscriptions purple; others reuse the closest existing chip', () => {
    assert.deepEqual(enquiryTypeColor('technical_support'), { bg: '#ebf3ff', fg: '#2469d6' })
    assert.deepEqual(enquiryTypeColor('payments_subscriptions'), { bg: '#efe9ff', fg: '#7756c7' })
    assert.deepEqual(enquiryTypeColor('course_content'), { bg: '#ebf3ff', fg: '#2469d6' })
    assert.deepEqual(enquiryTypeColor('other'), { bg: '#f2f5f9', fg: '#69778b' })
    assert.deepEqual(enquiryTypeColor('something_new'), { bg: '#f2f5f9', fg: '#69778b' })
  })
})
