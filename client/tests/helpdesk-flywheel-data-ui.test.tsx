import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { FlywheelMetrics, MetricsRow } from '../src/backoffice/contracts/helpdesk'
import { absent, deferred, installFakeServer, type Call, type FakeServer, type Reply } from './support/helpdesk-fake'
import { location, renderHelpDesk } from './support/helpdesk-render'

/**
 * v5 Part G6「HelpDesk 数据」（待视觉验收）：卡片（7 个比率，分母为 0 显示 —）、趋势表（按日 / 周）、
 * 切分（语言 / 入口 / 信号）、最大的缺口组、最常导致工单的 FAQ、加载与空状态。数字全部来自
 * GET /api/helpdesk/flywheel/metrics（事实表上的 SQL 视图，没有第二个数据源）。
 */

const METRICS = '/api/helpdesk/flywheel/metrics'

let server: FakeServer

function metricsRow(patch: Partial<MetricsRow> = {}): MetricsRow {
  return {
    bucket: null,
    segment: 'all',
    turns: 40,
    answers: 20,
    answersSettled: 16,
    aiSolved: 12,
    noMatch: 6,
    votes: 10,
    helpful: 7,
    ratings: 4,
    ratingSum: 17,
    handovers: 3,
    clarify: 5,
    clarifyCovered: 4,
    guarded: 20,
    guardFallback: 1,
    unsolved: 10,
    aiSolvedRate: 0.75,
    noMatchRate: 0.15,
    helpfulRate: 0.7,
    avgRating: 4.25,
    handoverRate: 0.075,
    clarifyCoveredRate: 0.8,
    guardFallbackRate: 0.05,
    ...patch,
  }
}

function metrics(patch: Partial<FlywheelMetrics> = {}): FlywheelMetrics {
  return {
    granularity: 'day',
    split: 'none',
    from: '2026-10-03',
    to: '2026-10-30',
    lastIngestedAt: '2026-10-29T18:04:00Z',
    source: 'portal_insights',
    series: [
      metricsRow({ bucket: '2026-10-28', turns: 15, aiSolvedRate: 0.5 }),
      metricsRow({ bucket: '2026-10-29', turns: 25, aiSolvedRate: null }),
    ],
    totals: [metricsRow()],
    topGaps: [
      { candidateId: 'c1', topic: 'Refund timing', proposedQuestion: 'How long does a refund take?', suggestion: 'add_phrasing', status: 'new', turns: 9 },
    ],
    ticketFaqs: [
      { faqId: 'f1', answers: 12, ticketsAfter: 3, ticketRate: 0.25, key: 'refund', questionEn: 'How do I get a refund?', questionZh: '怎么退款？' },
    ],
    ...patch,
  }
}

function serve(handler: (call: Call) => Reply | Promise<Reply>) {
  server.on('GET', METRICS, handler)
  server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
}

async function openData(options: { locale?: 'en-GB' | 'zh-CN'; role?: 'ADMIN' | 'COURSE_CREATOR' } = {}) {
  await renderHelpDesk(server, { role: options.role, path: `/${options.locale ?? 'en-GB'}/help-desk?tab=data` })
  await waitFor(() => assert.ok(server.callsTo('GET', METRICS).length >= 1))
}

function queries(): Record<string, string>[] {
  return server.callsTo('GET', METRICS).map((call) => Object.fromEntries(call.query))
}

const today = () => new Date().toISOString().slice(0, 10)

function card(label: string): HTMLElement {
  const element = screen.getByRole('group', { name: label })
  return element
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('HelpDesk data (G6)', () => {
  test('the last 28 days by day, no split: seven stat cards with their parts, the trend, gaps and ticket FAQs', async () => {
    serve(() => ({ data: metrics() }))
    await openData()
    const [first] = queries()
    assert.equal(first.granularity, 'day')
    assert.equal(first.split, 'none')
    assert.equal(first.to, today())
    assert.equal((Date.parse(first.to) - Date.parse(first.from)) / 86_400_000, 27)
    assert.equal(screen.getByRole('tab', { name: 'HelpDesk data' }).getAttribute('aria-selected'), 'true')

    await waitFor(() => card('AI-solved rate'))
    assert.equal(within(card('AI-solved rate')).getByText('75.0%').tagName, 'STRONG')
    assert.ok(within(card('AI-solved rate')).getByText('12 of 16'))
    assert.ok(within(card('No match rate')).getByText('15.0%'))
    assert.ok(within(card('Helpful rate')).getByText('70.0%'))
    assert.ok(within(card('Average rating')).getByText('4.25'))
    assert.ok(within(card('Handover rate')).getByText('7.5%'))
    assert.ok(within(card('Clarify covered rate')).getByText('80.0%'))
    assert.ok(within(card('Guard fallback rate')).getByText('5.0%'))
    assert.ok(screen.getByText('Data from Portal, last pulled 29 Oct 2026 18:04'))

    const trend = screen.getByRole('table', { name: 'Trend' })
    const trendRows = within(trend).getAllByRole('row').slice(1)
    assert.equal(trendRows.length, 2)
    assert.ok(within(trendRows[0]).getByText('28 Oct 2026'))
    assert.ok(within(trendRows[0]).getByText('50.0%'))
    assert.ok(within(trendRows[1]).getByText('—'))

    const gaps = screen.getByRole('table', { name: 'Top gap groups' })
    assert.ok(within(gaps).getByText('Refund timing'))
    assert.ok(within(gaps).getByText('9'))
    fireEvent.click(within(gaps).getByRole('button', { name: 'Open candidate Refund timing' }))
    await waitFor(() => assert.equal(location.current, '/en-GB/help-desk?tab=candidates&status=all&candidate=c1'))
  })

  test('FAQs that most often lead to a ticket show the question in the page language', async () => {
    serve(() => ({ data: metrics() }))
    await openData({ locale: 'zh-CN' })
    const table = await screen.findByRole('table', { name: '最常导致工单的 FAQ' })
    const rowElement = within(table).getByText('怎么退款？').closest('tr') as HTMLElement
    assert.ok(within(rowElement).getByText('12'))
    assert.ok(within(rowElement).getByText('3'))
    assert.ok(within(rowElement).getByText('25.0%'))
    assert.ok(screen.getByRole('group', { name: 'AI 解决率' }))
  })

  test('split by locale: cards stay overall, a segment table is added', async () => {
    serve((call) =>
      call.query.get('split') === 'locale'
        ? {
            data: metrics({
              split: 'locale',
              totals: [metricsRow({ segment: 'en-GB', turns: 10, aiSolvedRate: 0.6 }), metricsRow({ segment: 'zh-CN', turns: 30, aiSolvedRate: 0.85 })],
            }),
          }
        : { data: metrics() },
    )
    await openData()
    await waitFor(() => card('AI-solved rate'))
    fireEvent.change(screen.getByLabelText('Split by'), { target: { value: 'locale' } })
    const table = await screen.findByRole('table', { name: 'By locale' })
    const segments = within(table).getAllByRole('row').slice(1)
    assert.equal(segments.length, 2)
    assert.ok(within(segments[0]).getByText('English (UK)'))
    assert.ok(within(segments[0]).getByText('60.0%'))
    assert.ok(within(segments[1]).getByText('85.0%'))
    assert.ok(within(card('AI-solved rate')).getByText('75.0%'))
    const splits = queries().map((q) => q.split)
    assert.ok(splits.includes('locale') && splits.includes('none'))
  })

  test('weekly view: the range is in weeks and the query asks for weeks', async () => {
    serve(() => ({ data: metrics({ granularity: 'week' }) }))
    await openData()
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'week' } })
    await waitFor(() => assert.equal(queries().at(-1)?.granularity, 'week'))
    const range = screen.getByLabelText('Range') as HTMLSelectElement
    assert.deepEqual(
      Array.from(range.options).map((o) => o.textContent),
      ['Last 12 weeks', 'Last 26 weeks', 'Last 52 weeks'],
    )
    const q = queries().at(-1) as Record<string, string>
    assert.equal((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000, 12 * 7 - 1)
  })

  test('loading, then the empty state when the period has no turns', async () => {
    const pending = deferred<Reply>()
    serve(() => pending.promise)
    await openData()
    const region = document.querySelector('.hdFlywheel') as HTMLElement
    assert.equal(region.getAttribute('aria-busy'), 'true')
    assert.ok(screen.getByText('Loading…'))
    pending.resolve({ data: metrics({ totals: [], series: [], topGaps: [], ticketFaqs: [], lastIngestedAt: null }) })
    assert.ok(await screen.findByText('No conversations in this period yet. Data arrives with the nightly pull from Portal.'))
    assert.ok(screen.getByText('No data has been pulled from Portal yet.'))
    assert.equal(region.getAttribute('aria-busy'), 'false')
    absent(screen.queryByRole('group', { name: 'AI-solved rate' }))
  })

  test('days and weeks are UTC, a partial week is marked, and the source split is named for what it is (not a page)', async () => {
    serve((call) =>
      call.query.get('split') === 'entry'
        ? {
            data: metrics({
              split: 'entry',
              totals: [metricsRow({ segment: 'chat', turns: 30 }), metricsRow({ segment: 'chip', turns: 10 })],
            }),
          }
        : {
            data: metrics({
              granularity: 'week',
              timezone: 'UTC',
              weekStartsOn: 'monday',
              series: [
                metricsRow({ bucket: '2026-10-19', partial: false }),
                metricsRow({ bucket: '2026-10-26', partial: true }),
              ],
            }),
          },
    )
    await openData()
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'week' } })
    const trend = await screen.findByRole('table', { name: 'Trend' })
    await waitFor(() => assert.ok(within(trend).getByText('Week of 26 Oct 2026 (partial week)')))
    assert.ok(within(trend).getByText('Week of 19 Oct 2026'))
    assert.ok(screen.getByText('Days and weeks are in UTC; weeks start on Monday.'))
    const split = screen.getByLabelText('Split by') as HTMLSelectElement
    assert.ok(Array.from(split.options).some((o) => o.textContent === 'Channel'))
    fireEvent.change(split, { target: { value: 'entry' } })
    assert.ok(await screen.findByRole('table', { name: 'By channel' }))
    assert.ok(screen.getByText('Channel is where the question came from: the ticket form, the chat or a suggested question. It is not the page the learner was on.'))
  })

  test('zh-CN: UTC note and the channel split', async () => {
    serve(() => ({ data: metrics() }))
    await openData({ locale: 'zh-CN' })
    await waitFor(() => card('AI 解决率'))
    assert.ok(screen.getByText('日期按 UTC 计，每周从周一开始。'))
    const split = screen.getByLabelText('切分') as HTMLSelectElement
    assert.ok(Array.from(split.options).some((o) => o.textContent === '渠道'))
  })

  test('an error is announced', async () => {
    serve(() => ({ status: 503, error: 'HELPDESK_UNAVAILABLE' }))
    await openData()
    assert.equal((await screen.findByRole('alert')).textContent, 'HelpDesk is unavailable right now. Please try again.')
  })

  test('VIEW can read the data', async () => {
    serve(() => ({ data: metrics() }))
    await openData({ role: 'COURSE_CREATOR' })
    await waitFor(() => card('AI-solved rate'))
  })
})
