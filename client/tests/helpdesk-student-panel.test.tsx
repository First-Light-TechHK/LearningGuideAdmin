import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { EnquiryDetail } from '../src/backoffice/contracts/helpdesk'
import { StudentPanel } from '../src/backoffice/helpdesk/StudentPanel'
import type { Locale } from '../src/backoffice/lib/i18n/config'
import { absent, detail } from './support/helpdesk-fake'

/** 右栏（Figma 1324:2 RightSidebar）：学员信息、当前订阅、标签。 */

afterEach(cleanup)

function renderPanel(ticket: EnquiryDetail, options: { locale?: Locale; editTags?: boolean; busy?: string | null } = {}) {
  const added: string[] = []
  const removed: string[] = []
  render(
    <StudentPanel
      locale={options.locale ?? 'en-GB'}
      ticket={ticket}
      editTags={options.editTags ?? true}
      busy={options.busy ?? null}
      onAddTag={async (tag) => {
        added.push(tag)
        return true
      }}
      onRemoveTag={(tag) => removed.push(tag)}
    />,
  )
  return { added, removed }
}

/** <dt>label</dt><dd>value</dd> 的值。 */
function fact(label: string): string {
  const term = screen.getAllByText(label).find((node) => node.tagName === 'DT')
  assert.ok(term, `term ${label}`)
  return term.nextElementSibling?.textContent ?? ''
}

describe('StudentPanel student information', () => {
  test('shows the Portal projection; Student ID is the Portal user id', () => {
    renderPanel(
      detail('a', {
        contactEmail: 'ticket-contact@example.com',
        student: {
          id: 'portal-user-42',
          name: 'Emily Carter',
          accountEmail: 'emily@example.com',
          contactEmail: 'emily.work@example.com',
          joinedAt: '2024-01-15T00:00:00Z',
          totalEnquiries: 4,
          currentCourse: { id: 'c1', title: 'A-level Maths' },
        },
      }),
    )
    assert.ok(screen.getByRole('complementary', { name: 'Student Information' }))
    assert.ok(screen.getByRole('heading', { name: 'Emily Carter' }))
    assert.equal(screen.getByRole('link', { name: 'emily@example.com' }).getAttribute('href'), 'mailto:emily@example.com')
    assert.equal(fact('Account Email'), 'emily@example.com')
    assert.equal(fact('Contact Email'), 'emily.work@example.com')
    assert.equal(fact('Joined Date'), '15 Jan 2024')
    assert.equal(fact('Student ID'), 'portal-user-42')
    assert.equal(fact('Total Enquiries'), '4')
    assert.equal(fact('Current Course'), 'A-level Maths')
  })

  test('without a student projection falls back to the ticket learner; missing values are —', () => {
    renderPanel(
      detail('a', {
        learner: { id: 'portal-user-7', email: 'li@example.com', name: '' },
        contactEmail: null,
        student: null,
      }),
    )
    assert.ok(screen.getByRole('heading', { name: 'li@example.com' }))
    assert.equal(fact('Account Email'), 'li@example.com')
    assert.equal(fact('Contact Email'), '—')
    assert.equal(fact('Joined Date'), '—')
    assert.equal(fact('Student ID'), 'portal-user-7')
    assert.equal(fact('Total Enquiries'), '—')
    assert.equal(fact('Current Course'), '—')
  })

  test('student contact email null falls back to the ticket contact email', () => {
    const base = detail('a', { contactEmail: 'from-ticket@example.com' })
    renderPanel({ ...base, student: { ...(base.student as NonNullable<EnquiryDetail['student']>), contactEmail: null } })
    assert.equal(fact('Contact Email'), 'from-ticket@example.com')
  })

  test('total enquiries 0 is shown as 0, not —', () => {
    const base = detail('a')
    renderPanel({ ...base, student: { ...(base.student as NonNullable<EnquiryDetail['student']>), totalEnquiries: 0 } })
    assert.equal(fact('Total Enquiries'), '0')
  })
})

describe('StudentPanel subscription', () => {
  test('plan name, billing cycle, status pill and renewal date', () => {
    renderPanel(
      detail('a', {
        subscription: { planName: 'Premium', billingCycle: 'Monthly', status: 'past_due', renewalDate: '2026-12-01T00:00:00Z' },
      }),
    )
    assert.ok(screen.getByRole('heading', { name: 'Current Subscription Plan' }))
    assert.equal(fact('Plan Name'), 'Premium')
    assert.equal(fact('Billing Cycle'), 'Monthly')
    assert.equal(fact('Renewal Date'), '1 Dec 2026')
    const pill = screen.getByText('Past due')
    assert.match(pill.className, /^hdPill hdPill-/)
  })

  test('no subscription shows — everywhere', () => {
    renderPanel(detail('a', { subscription: null }))
    for (const label of ['Plan Name', 'Billing Cycle', 'Status', 'Renewal Date']) {
      assert.equal(fact(label), '—', label)
    }
  })

  test('unknown billing cycle / status show the raw value', () => {
    renderPanel(detail('a', { subscription: { planName: 'Pro', billingCycle: 'fortnightly', status: 'frozen', renewalDate: null } }))
    assert.equal(fact('Billing Cycle'), 'fortnightly')
    assert.equal(fact('Status'), 'frozen')
    assert.equal(fact('Renewal Date'), '—')
  })

  test('zh-CN labels and dates', () => {
    renderPanel(detail('a'), { locale: 'zh-CN' })
    assert.ok(screen.getByRole('complementary', { name: '学员信息' }))
    assert.equal(fact('学员 ID'), 'user-a')
    assert.equal(fact('注册日期'), '2024年1月15日')
    assert.ok(screen.getByRole('heading', { name: '当前订阅方案' }))
    assert.equal(fact('计费周期'), '按月')
    assert.equal(fact('状态'), '生效中')
    assert.equal(fact('续费日期'), '2026年12月1日')
    assert.ok(screen.getByText('还没有标签。'))
    assert.ok(screen.getByRole('button', { name: /添加标签/ }))
  })
})

describe('StudentPanel tags', () => {
  test('lists tags; no tags says so', () => {
    renderPanel(detail('a', { tags: [] }))
    assert.ok(screen.getByText('No tags yet.'))
    cleanup()
    renderPanel(detail('a', { tags: ['login issue', 'payment'] }))
    assert.ok(screen.getByText('login issue'))
    assert.ok(screen.getByText('payment'))
  })

  test('adds a normalised tag on Enter and closes the editor on success', async () => {
    const { added } = renderPanel(detail('a', { tags: [] }))
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    absent(screen.queryByRole('button', { name: /Add Tag/ }), 'add button hides while editing')
    const input = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(input, { target: { value: ' a  b ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('button', { name: /Add Tag/ })
    assert.deepEqual(added, ['a b'])
  })

  test('IME composition Enter and Escape are left to the IME', () => {
    const { added } = renderPanel(detail('a', { tags: [] }))
    fireEvent.click(screen.getByRole('button', { name: /Add Tag/ }))
    const input = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(input, { target: { value: '退款' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    assert.deepEqual(added, [])
    assert.ok(screen.getByRole('textbox', { name: 'New tag' }), 'editor still open')
  })

  test('remove buttons call back with the tag; busy disables them and Add Tag', () => {
    const { removed } = renderPanel(detail('a', { tags: ['vip'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag vip' }))
    assert.deepEqual(removed, ['vip'])
    cleanup()
    renderPanel(detail('a', { tags: ['vip'] }), { busy: 'tag' })
    assert.equal((screen.getByRole('button', { name: 'Remove tag vip' }) as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByRole('button', { name: /Add Tag/ }) as HTMLButtonElement).disabled, true)
  })

  test('without editTags (VIEW) there are no tag controls', () => {
    renderPanel(detail('a', { tags: ['vip'] }), { editTags: false })
    assert.ok(screen.getByText('vip'))
    absent(screen.queryByRole('button'))
    absent(screen.queryByRole('textbox'))
  })
})
