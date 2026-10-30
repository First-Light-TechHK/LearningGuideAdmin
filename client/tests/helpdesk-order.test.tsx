import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { EnquiryDetail, TicketOrder } from '../src/backoffice/contracts/helpdesk'
import { EnquiryList } from '../src/backoffice/helpdesk/EnquiryList'
import { StudentPanel } from '../src/backoffice/helpdesk/StudentPanel'
import { formatOrderAmount, orderStatusLabel, paymentModeLabel } from '../src/backoffice/lib/helpdeskFormat'
import { DEFAULT_ENQUIRY_FILTERS, orderTone } from '../src/backoffice/lib/helpdeskView'
import type { Locale } from '../src/backoffice/lib/i18n/config'
import { absent, detail, row } from './support/helpdesk-fake'

/**
 * v4 Part A（helpdesk-v4-order-and-chat-end.md）：工单关联的订单。右栏在订阅块旁边多一个「订单 / Order」块
 * （订单号可复制、状态、金额、方案、日期、支付方式），左栏有订单的行带一个小「订单」标签。
 * 订单数据只来自 Portal 的只读投影（经 Admin Server），AI 助手从不接触。
 */

afterEach(cleanup)

const ORDER: TicketOrder = {
  id: 'order_1761640741859_9f3a2c1d',
  status: 'paid',
  amount: 3900,
  currency: 'usd',
  planName: 'Epicureanism · PC · 6 months',
  kind: 'purchase',
  createdAt: '2026-10-28T08:39:01.859Z',
  paymentMode: 'stripe',
}

function renderPanel(ticket: EnquiryDetail, locale: Locale = 'en-GB') {
  return render(
    <StudentPanel
      locale={locale}
      ticket={ticket}
      editTags={false}
      busy={null}
      onAddTag={async () => true}
      onRemoveTag={() => undefined}
    />,
  )
}

function orderBlock(name = 'Order'): HTMLElement {
  return screen.getByRole('region', { name })
}

/** <dt>label</dt><dd>value</dd> 的值（限定在订单块里）。 */
function fact(block: HTMLElement, label: string): HTMLElement {
  const term = within(block)
    .getAllByText(label)
    .find((node) => node.tagName === 'DT')
  assert.ok(term, `term ${label}`)
  const value = term.nextElementSibling
  assert.ok(value instanceof HTMLElement, `value of ${label}`)
  return value
}

type ClipboardStub = { written: string[]; fail: boolean }
let clipboard: ClipboardStub

beforeEach(() => {
  clipboard = { written: [], fail: false }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        if (clipboard.fail) throw new Error('denied')
        clipboard.written.push(value)
      },
    },
  })
})

describe('v4 order block in the right column', () => {
  test('sits right after the subscription block and shows number, status, amount, plan, date and payment mode', () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: ORDER }))
    const block = orderBlock()
    assert.ok(within(block).getByRole('heading', { name: 'Order' }))
    // next to the subscription block: the order block is the section after it
    const subscription = screen.getByRole('heading', { name: 'Current Subscription Plan' }).closest('section')
    assert.equal(subscription?.nextElementSibling, block)

    assert.match(fact(block, 'Order number').textContent ?? '', new RegExp(ORDER.id))
    const pill = within(fact(block, 'Status')).getByText('Paid')
    assert.match(pill.className, /^hdPill hdPill-success$/)
    assert.equal(fact(block, 'Amount').textContent, formatOrderAmount('en-GB', 3900, 'usd'))
    assert.match(fact(block, 'Amount').textContent ?? '', /39\.00/)
    assert.equal(fact(block, 'Plan').textContent, 'Epicureanism · PC · 6 months')
    assert.equal(fact(block, 'Order date').textContent, '28 Oct 2026')
    assert.equal(fact(block, 'Payment mode').textContent, 'Stripe')
  })

  test('zh-CN labels, values and dates', () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: { ...ORDER, status: 'refunded', paymentMode: 'demo' } }), 'zh-CN')
    const block = orderBlock('订单')
    assert.ok(within(block).getByRole('heading', { name: '订单' }))
    assert.match(fact(block, '订单号').textContent ?? '', new RegExp(ORDER.id))
    assert.ok(within(fact(block, '状态')).getByText('已退款'))
    assert.match(fact(block, '金额').textContent ?? '', /39\.00/)
    assert.equal(fact(block, '方案').textContent, 'Epicureanism · PC · 6 months')
    assert.equal(fact(block, '下单日期').textContent, '2026年10月28日')
    assert.equal(fact(block, '支付方式').textContent, '演示支付')
    assert.ok(within(block).getByRole('button', { name: `复制订单号 ${ORDER.id}` }))
  })

  test('the order number is copied with one click and the copy is announced', async () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: ORDER }))
    const block = orderBlock()
    const button = within(block).getByRole('button', { name: `Copy order number ${ORDER.id}` })
    assert.equal(button.textContent, 'Copy')
    await act(async () => {
      fireEvent.click(button)
    })
    assert.deepEqual(clipboard.written, [ORDER.id])
    assert.equal(within(block).getByRole('status').textContent, 'Order number copied.')
    assert.equal(button.textContent, 'Copied')
  })

  test('keyboard: the copy control is a real button reachable by Tab', () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: ORDER }))
    const button = within(orderBlock()).getByRole('button', { name: `Copy order number ${ORDER.id}` }) as HTMLButtonElement
    assert.equal(button.tagName, 'BUTTON')
    assert.equal(button.type, 'button')
    assert.equal(button.disabled, false)
    assert.notEqual(button.tabIndex, -1)
  })

  test('when the browser refuses the clipboard, the number is selected and the agent is told to press Ctrl+C', async () => {
    clipboard.fail = true
    renderPanel(detail('a', { orderId: ORDER.id, order: ORDER }))
    const block = orderBlock()
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: `Copy order number ${ORDER.id}` }))
    })
    assert.deepEqual(clipboard.written, [])
    assert.equal(window.getSelection()?.toString(), ORDER.id)
    assert.equal(within(block).getByRole('status').textContent, 'Press Ctrl+C (⌘C on Mac) to copy the selected order number.')
  })

  test('there is no link to an order page: neither Order Management can open an order by URL (number and copy only)', () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: ORDER }))
    absent(within(orderBlock()).queryByRole('link'))
  })

  test('orderId without a projection (Portal could not read the order): number and copy, plus a note', () => {
    renderPanel(detail('a', { orderId: ORDER.id, order: null }))
    const block = orderBlock()
    assert.match(fact(block, 'Order number').textContent ?? '', new RegExp(ORDER.id))
    assert.ok(within(block).getByRole('button', { name: `Copy order number ${ORDER.id}` }))
    assert.ok(within(block).getByText('Order details are not available right now.'))
    for (const label of ['Status', 'Amount', 'Plan', 'Order date', 'Payment mode']) {
      assert.equal(fact(block, label).textContent, '—', label)
    }
  })

  test('missing fields show —; unknown status / payment mode show the raw value', () => {
    renderPanel(
      detail('a', {
        orderId: ORDER.id,
        order: { id: ORDER.id, status: 'partially_refunded', amount: null, currency: 'usd', planName: null, kind: null, createdAt: null, paymentMode: 'paypal' },
      }),
    )
    const block = orderBlock()
    assert.ok(within(fact(block, 'Status')).getByText('partially_refunded'))
    assert.equal(fact(block, 'Amount').textContent, '—')
    assert.equal(fact(block, 'Plan').textContent, '—')
    assert.equal(fact(block, 'Order date').textContent, '—')
    assert.equal(fact(block, 'Payment mode').textContent, 'paypal')
  })

  test('a ticket without an order has no order block (old servers send no field at all)', () => {
    renderPanel(detail('a', { orderId: null, order: null }))
    absent(screen.queryByRole('region', { name: 'Order' }))
    cleanup()
    const legacy = detail('a') as Partial<EnquiryDetail>
    delete legacy.orderId
    delete legacy.order
    renderPanel(legacy as EnquiryDetail)
    absent(screen.queryByRole('region', { name: 'Order' }))
    assert.ok(screen.getByRole('heading', { name: 'Current Subscription Plan' }))
  })
})

describe('v4 order tag in the ticket list', () => {
  function renderList(rows: ReturnType<typeof row>[], locale: Locale = 'en-GB') {
    render(
      <EnquiryList
        locale={locale}
        rows={rows}
        selectedId={null}
        filters={DEFAULT_ENQUIRY_FILTERS}
        query=""
        loading={false}
        loadingMore={false}
        hasMore={false}
        errorCode={null}
        onQueryChange={() => undefined}
        onFiltersChange={() => undefined}
        onSelect={() => undefined}
        onLoadMore={() => undefined}
      />,
    )
  }

  test('a row with orderId shows a small order tag naming the order; others do not', () => {
    renderList([row('a', { subject: 'Refund please', orderId: ORDER.id }), row('b', { subject: 'Plain one', orderId: null }), row('c', { subject: 'Old server' })])
    const withOrder = screen.getByRole('button', { name: /Refund please/ })
    const tag = within(withOrder).getByRole('img', { name: `Linked order ${ORDER.id}` })
    assert.equal(tag.textContent, 'Order')
    assert.match(tag.className, /\bhdPill hdPill-neutral hdRowOrder\b/)
    absent(within(screen.getByRole('button', { name: /Plain one/ })).queryByRole('img', { name: /order/i }))
    absent(within(screen.getByRole('button', { name: /Old server/ })).queryByRole('img', { name: /order/i }))
  })

  test('zh-CN tag', () => {
    renderList([row('a', { subject: 'Refund please', orderId: ORDER.id })], 'zh-CN')
    const tag = within(screen.getByRole('button', { name: /Refund please/ })).getByRole('img', { name: `关联订单 ${ORDER.id}` })
    assert.equal(tag.textContent, '订单')
  })
})

describe('v4 order formatting', () => {
  test('amounts are integer minor units in the order currency', () => {
    assert.match(formatOrderAmount('en-GB', 3900, 'usd'), /^US\$39\.00$/)
    assert.match(formatOrderAmount('en-GB', 12900, 'gbp'), /^£129\.00$/)
    assert.match(formatOrderAmount('zh-CN', 3900, 'usd'), /39\.00/)
    // a zero-decimal currency is not divided by 100
    assert.match(formatOrderAmount('en-GB', 3900, 'jpy'), /3,900/)
    assert.match(formatOrderAmount('en-GB', 0, 'usd'), /0\.00/)
    assert.equal(formatOrderAmount('en-GB', null, 'usd'), '—')
    assert.equal(formatOrderAmount('en-GB', 3900, null), '—')
  })

  test('status tones: paid green; pending / failed amber; cancelled / refunded / unknown neutral', () => {
    assert.equal(orderTone('paid'), 'success')
    assert.equal(orderTone('pending'), 'warning')
    assert.equal(orderTone('failed'), 'warning')
    assert.equal(orderTone('canceled'), 'neutral')
    assert.equal(orderTone('refunded'), 'neutral')
    assert.equal(orderTone('whatever'), 'neutral')
  })

  test('labels fall back to the raw value for values Portal adds later', () => {
    assert.equal(orderStatusLabel('en-GB', 'canceled'), 'Cancelled')
    assert.equal(orderStatusLabel('zh-CN', 'paid'), '已支付')
    assert.equal(orderStatusLabel('en-GB', 'disputed'), 'disputed')
    assert.equal(paymentModeLabel('en-GB', 'demo'), 'Demo')
    assert.equal(paymentModeLabel('zh-CN', 'stripe'), 'Stripe 在线支付')
    assert.equal(paymentModeLabel('zh-CN', 'paypal'), 'paypal')
  })
})
