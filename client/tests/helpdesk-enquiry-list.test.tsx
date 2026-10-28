import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { EnquiryRow } from '../src/backoffice/contracts/helpdesk'
import { EnquiryList } from '../src/backoffice/helpdesk/EnquiryList'
import type { Locale } from '../src/backoffice/lib/i18n/config'
import { DEFAULT_ENQUIRY_FILTERS, type EnquiryFilters } from '../src/backoffice/lib/helpdeskView'
import { absent, row } from './support/helpdesk-fake'

/**
 * 左栏（Figma 1324:2 LeftPanel）：行内容、未读点、选中态、空状态、搜索与筛选面板。
 * 只测组件本身（props 进、回调出），与 Server 的往返在 helpdesk-enquiries.test.tsx。
 */

afterEach(cleanup)

type Spy<A extends unknown[]> = ((...args: A) => void) & { calls: A[] }
function spy<A extends unknown[]>(): Spy<A> {
  const calls: A[] = []
  const fn = ((...args: A) => {
    calls.push(args)
  }) as Spy<A>
  fn.calls = calls
  return fn
}

function renderList(
  overrides: {
    locale?: Locale
    rows?: EnquiryRow[]
    selectedId?: string | null
    filters?: Partial<EnquiryFilters>
    query?: string
    loading?: boolean
    loadingMore?: boolean
    hasMore?: boolean
    errorCode?: string | null
  } = {},
) {
  const onQueryChange = spy<[string]>()
  const onFiltersChange = spy<[Partial<EnquiryFilters>]>()
  const onSelect = spy<[string]>()
  const onLoadMore = spy<[]>()
  const view = render(
    <EnquiryList
      locale={overrides.locale ?? 'en-GB'}
      rows={overrides.rows ?? []}
      selectedId={overrides.selectedId ?? null}
      filters={{ ...DEFAULT_ENQUIRY_FILTERS, ...overrides.filters }}
      query={overrides.query ?? ''}
      loading={overrides.loading ?? false}
      loadingMore={overrides.loadingMore ?? false}
      hasMore={overrides.hasMore ?? false}
      errorCode={overrides.errorCode ?? null}
      onQueryChange={onQueryChange}
      onFiltersChange={onFiltersChange}
      onSelect={onSelect}
      onLoadMore={onLoadMore}
    />,
  )
  return { view, onQueryChange, onFiltersChange, onSelect, onLoadMore }
}

function rowButton(subject: string): HTMLElement {
  const button = screen.getByText(subject).closest('button')
  assert.ok(button, `row button for ${subject}`)
  return button
}

/** 今年里、但不是今天的某一天（年份只在往年才显示）。 */
function thisYearNotToday(): { iso: string; en: string; zh: string } {
  const now = new Date()
  const month = now.getUTCMonth() === 0 ? 11 : 0
  const iso = new Date(Date.UTC(now.getUTCFullYear(), month, 15, 10, 0)).toISOString()
  return month === 0 ? { iso, en: '15 Jan', zh: '1月15日' } : { iso, en: '15 Dec', zh: '12月15日' }
}

describe('EnquiryList rows', () => {
  test('each row shows initials, learner name, time, subject, preview and the unread dot', () => {
    const today = new Date()
    today.setUTCHours(14, 32, 0, 0)
    const earlier = thisYearNotToday()
    renderList({
      rows: [
        row('a', {
          learner: { id: 'u-1', email: 'emily@example.com', name: 'Emily Carter' },
          subject: 'Cannot log in',
          preview: 'I tried resetting my password twice',
          lastMessageAt: today.toISOString(),
          unreadByAgent: true,
        }),
        row('b', {
          learner: { id: 'u-2', email: 'li@example.com', name: '李雷' },
          subject: 'Refund',
          preview: 'Please refund',
          lastMessageAt: earlier.iso,
          unreadByAgent: false,
        }),
        row('c', {
          learner: { id: 'u-3', email: 'zoe@example.com', name: '' },
          subject: 'Old one',
          preview: 'From last year',
          lastMessageAt: '2024-05-16T10:00:00Z',
        }),
      ],
    })

    const a = rowButton('Cannot log in')
    assert.equal(within(a).getByText('EC').getAttribute('aria-hidden'), 'true')
    assert.ok(within(a).getByText('Emily Carter'))
    assert.equal(within(a).getByText('14:32').tagName, 'TIME')
    assert.ok(within(a).getByText('I tried resetting my password twice'))
    assert.ok(within(a).getByRole('img', { name: 'Unread' }))
    assert.match(a.className, /hdRowUnread/)

    const b = rowButton('Refund')
    assert.ok(within(b).getByText('李'), 'CJK names use the first character')
    assert.ok(within(b).getByText(earlier.en))
    absent(within(b).queryByRole('img', { name: 'Unread' }))
    assert.doesNotMatch(b.className, /hdRowUnread/)

    // 没有名字：显示邮箱，首字母取邮箱；往年带年份
    const c = rowButton('Old one')
    assert.ok(within(c).getByText('zoe@example.com'))
    assert.ok(within(c).getByText('Z'))
    assert.ok(within(c).getByText('16 May 2024'))
  })

  test('falls back to updatedAt when there is no message time', () => {
    renderList({ rows: [row('a', { lastMessageAt: null, updatedAt: '2024-03-02T08:00:00Z' })] })
    const time = within(rowButton('Subject a')).getByText('2 Mar 2024')
    assert.equal(time.getAttribute('datetime'), '2024-03-02T08:00:00Z')
  })

  test('zh-CN formats dates in Chinese and labels the unread dot', () => {
    const earlier = thisYearNotToday()
    renderList({
      locale: 'zh-CN',
      rows: [row('a', { lastMessageAt: earlier.iso, unreadByAgent: true })],
    })
    const a = rowButton('Subject a')
    assert.ok(within(a).getByText(earlier.zh))
    assert.ok(within(a).getByRole('img', { name: '未读' }))
    assert.ok(screen.getByRole('searchbox', { name: '搜索学员或咨询...' }))
  })

  test('a flagged row shows the flag icon; others do not (v2 §3d)', () => {
    renderList({ rows: [row('a', { subject: 'Flagged one', flagged: true }), row('b', { subject: 'Plain one' })] })
    assert.ok(within(rowButton('Flagged one')).getByRole('img', { name: 'Flagged for follow-up' }))
    absent(within(rowButton('Plain one')).queryByRole('img', { name: 'Flagged for follow-up' }))
    cleanup()
    renderList({ locale: 'zh-CN', rows: [row('a', { subject: 'Flagged one', flagged: true })] })
    assert.ok(within(rowButton('Flagged one')).getByRole('img', { name: '已标记跟进' }))
  })

  test('the selected row is marked current and clicking a row selects it', () => {
    const { onSelect } = renderList({ rows: [row('a'), row('b')], selectedId: 'b' })
    assert.equal(rowButton('Subject b').getAttribute('aria-current'), 'true')
    assert.equal(rowButton('Subject a').getAttribute('aria-current'), null)
    fireEvent.click(rowButton('Subject a'))
    assert.deepEqual(onSelect.calls, [['a']])
  })
})

describe('EnquiryList states', () => {
  test('empty list says so, and says "match your search" when filtered', () => {
    renderList()
    assert.ok(screen.getByText('No enquiries yet.'))
    cleanup()
    renderList({ filters: { q: 'refund' } })
    assert.ok(screen.getByText('No enquiries match your search or filters.'))
    cleanup()
    renderList({ filters: { status: 'OPEN' } })
    assert.ok(screen.getByText('No enquiries match your search or filters.'))
  })

  test('loading shows Loading… and an error shows the mapped message instead of "empty"', () => {
    renderList({ loading: true })
    assert.ok(screen.getByText('Loading…'))
    cleanup()
    renderList({ errorCode: 'HELPDESK_UNAVAILABLE' })
    assert.equal(screen.getByRole('alert').textContent, 'HelpDesk is unavailable right now. Please try again.')
    absent(screen.queryByText('No enquiries yet.'))
  })

  test('more pages show a sentinel; loading more says so', () => {
    renderList({ rows: [row('a')], hasMore: true, loadingMore: true })
    assert.ok(screen.getByText('Loading more…'))
  })
})

describe('EnquiryList search and filters', () => {
  test('typing in search reports the raw value', () => {
    const { onQueryChange } = renderList({ query: '' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search students or enquiries...' }), {
      target: { value: 'all' },
    })
    assert.deepEqual(onQueryChange.calls, [['all']])
  })

  test('filter button shows the active filter count (search not counted)', () => {
    renderList({ filters: { q: 'x', status: 'OPEN', tag: 'vip' } })
    const button = screen.getByRole('button', { name: /Filter enquiries/ })
    assert.equal(within(button).getByText('2').className, 'hdFilterCount')
    cleanup()
    renderList({ filters: { q: 'x' } })
    absent(screen.getByRole('button', { name: 'Filter enquiries' }).querySelector('.hdFilterCount'))
  })

  test('status and type selects offer "All" as the literal value all, plus every status', () => {
    const { onFiltersChange } = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Filter enquiries' }))
    const panel = screen.getByRole('dialog', { name: 'Filter enquiries' })
    const status = within(panel).getByLabelText('Status') as HTMLSelectElement
    const values = Array.from(status.options).map((option) => [option.value, option.textContent])
    assert.deepEqual(values, [
      ['all', 'All'],
      ['needs_reply', 'Needs reply'],
      ['OPEN', 'New'],
      ['ASSIGNED', 'In progress'],
      ['WAITING_USER', 'Waiting for learner'],
      ['PENDING_CONFIRM', 'Awaiting confirmation'],
      ['CLOSED', 'Closed'],
      ['CANCELLED', 'Withdrawn'],
    ])
    const category = within(panel).getByLabelText('Enquiry Type') as HTMLSelectElement
    assert.deepEqual(
      Array.from(category.options).map((option) => option.value),
      ['all', 'technical_support', 'course_content', 'payments_subscriptions', 'other'],
    )

    fireEvent.change(status, { target: { value: 'needs_reply' } })
    fireEvent.change(category, { target: { value: 'payments_subscriptions' } })
    fireEvent.change(status, { target: { value: 'all' } })
    assert.deepEqual(onFiltersChange.calls, [
      [{ status: 'needs_reply' }],
      [{ category: 'payments_subscriptions' }],
      [{ status: 'all' }],
    ])
  })

  test('tag filter applies on Enter and on blur, but not on an IME composition Enter', () => {
    const { onFiltersChange } = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Filter enquiries' }))
    const tag = screen.getByLabelText('Tag')
    fireEvent.change(tag, { target: { value: '退款' } })
    fireEvent.keyDown(tag, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(tag, { key: 'Enter', isComposing: true })
    assert.deepEqual(onFiltersChange.calls, [])
    fireEvent.keyDown(tag, { key: 'Enter' })
    assert.deepEqual(onFiltersChange.calls, [[{ tag: '退款' }]])
    fireEvent.change(tag, { target: { value: 'all' } })
    fireEvent.blur(tag)
    assert.deepEqual(onFiltersChange.calls.at(-1), [{ tag: 'all' }])
  })

  test('Flagged (v2 §3d) is a checkbox in the filter panel and counts as an active filter', () => {
    const { onFiltersChange } = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Filter enquiries' }))
    const flagged = screen.getByRole('checkbox', { name: 'Flagged' }) as HTMLInputElement
    assert.equal(flagged.checked, false)
    fireEvent.click(flagged)
    assert.deepEqual(onFiltersChange.calls, [[{ flagged: true }]])
    cleanup()
    const second = renderList({ filters: { flagged: true } })
    const button = screen.getByRole('button', { name: /Filter enquiries/ })
    assert.equal(within(button).getByText('1').className, 'hdFilterCount')
    fireEvent.click(button)
    const checked = screen.getByRole('checkbox', { name: 'Flagged' }) as HTMLInputElement
    assert.equal(checked.checked, true)
    fireEvent.click(checked)
    assert.deepEqual(second.onFiltersChange.calls, [[{ flagged: false }]])
  })

  test('Clear filters resets status, type, tag and flagged; Close hides the panel', () => {
    const { onFiltersChange } = renderList({ filters: { status: 'OPEN', category: 'other', tag: 'vip', flagged: true } })
    fireEvent.click(screen.getByRole('button', { name: /Filter enquiries/ }))
    assert.equal((screen.getByLabelText('Tag') as HTMLInputElement).value, 'vip')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    assert.deepEqual(onFiltersChange.calls, [[{ status: 'all', category: 'all', tag: '', flagged: false }]])
    assert.equal((screen.getByLabelText('Tag') as HTMLInputElement).value, '')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    absent(screen.queryByRole('dialog'))
  })

  test('zh-CN filter panel text', () => {
    renderList({ locale: 'zh-CN' })
    fireEvent.click(screen.getByRole('button', { name: '筛选咨询' }))
    const status = screen.getByLabelText('状态') as HTMLSelectElement
    assert.equal(status.options[0].textContent, '全部')
    assert.equal(status.options[1].textContent, '待回复')
    assert.ok(screen.getByLabelText('咨询类型'))
    assert.ok(screen.getByRole('checkbox', { name: '已标记跟进' }))
    assert.ok(screen.getByRole('button', { name: '清除筛选' }))
    assert.ok(screen.getByText('还没有咨询。'))
  })
})
