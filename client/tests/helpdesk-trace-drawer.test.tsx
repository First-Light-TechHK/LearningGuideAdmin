import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { AgentRun, EnquiryDetail } from '../src/backoffice/contracts/helpdesk'
import { deferred, detail, installFakeServer, type FakeServer, type Reply } from './support/helpdesk-fake'
import { renderHelpDesk } from './support/helpdesk-render'

/**
 * 「查看链路」（helpdesk-agent-v2-pi-dsh §2）：每个 AI 块一个只读入口，抽屉显示这次推荐的 run
 *（GET /api/helpdesk/agent-runs/:runId，AI 块的 id 就是 run id）：时间偏移、事件类型、模型、token、费用、
 * 候选、选中的 FAQ、工具参数、错误、结束原因。helpDesk 的 VIEW 角色也能看；抽屉没有任何写控件。
 * 抽屉沿用 FAQ 抽屉的样式（无画板，待视觉验收）。
 */

const LIST = '/api/helpdesk/tickets'
const DETAIL = /^\/api\/helpdesk\/tickets\/[^/]+$/
const RUN = '0192eeee-0000-7000-8000-0000000000a1'
const OTHER_RUN = '0192eeee-0000-7000-8000-0000000000a2'
const ROOT = '0192eeee-0000-7000-8000-0000000000a0'
const FAQ_A = '0192f000-0000-7000-8000-000000000001'
const FAQ_B = '0192f000-0000-7000-8000-000000000002'
const T0 = Date.parse('2026-10-29T09:00:00.000Z')

let server: FakeServer

function at(ms: number) {
  return new Date(T0 + ms).toISOString()
}

function run(runId = RUN): AgentRun {
  const e = (seq: number, ms: number, type: string, data: Record<string, unknown>) => ({ runId, seq, type, time: at(ms), data })
  return {
    runId,
    parentRunId: ROOT,
    chain: [ROOT, runId],
    events: [
      e(1, 0, 'turn/start', { turn: 1, workflow: 'faq', source: 'chat', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', input: { redacted: true } }),
      e(2, 2, 'step/start', { turn: 1, step: 1, name: 'retrieve', kind: 'code' }),
      e(3, 40, 'step/end', {
        turn: 1,
        step: 1,
        name: 'retrieve',
        kind: 'code',
        then: { next: 'pick_faq' },
        output: { candidates: [{ id: FAQ_A, score: 0.9 }, { id: FAQ_B, score: 0.4 }] },
      }),
      e(4, 41, 'step/start', { turn: 1, step: 2, name: 'pick_faq', kind: 'agent', tools: ['pick_faq'] }),
      e(5, 42, 'request/context', { turn: 1, step: 2, provider: 'openrouter', model: 'openai/gpt-4o-mini', api: 'openai-completions' }),
      e(6, 900, 'assistant/message', {
        turn: 1,
        step: 2,
        model: 'openai/gpt-4o-mini',
        usage: { inputTokens: 512, outputTokens: 9 },
        costUsd: 0.0000822,
        stopReason: 'toolUse',
        text: { redacted: true },
      }),
      e(7, 901, 'tool/call', { turn: 1, step: 2, callId: 'c1', name: 'pick_faq', arguments: `{"faqId":"${FAQ_A}"}` }),
      e(8, 902, 'tool/result', { turn: 1, step: 2, callId: 'c2', name: 'pick_faq', error: { name: 'ToolError', code: 'too_many_calls' } }),
      e(9, 903, 'step/end', { turn: 1, step: 2, name: 'pick_faq', kind: 'agent', outcome: 'called', args: { faqId: FAQ_A }, then: { next: 'validate' } }),
      e(10, 910, 'turn/end', { turn: 1, reason: 'answered', faqId: FAQ_A, model: 'openai/gpt-4o-mini', latencyMs: 910 }),
      e(11, 1_500, 'feedback', { outcome: 'helpful' }),
      e(12, 90_000, 'feedback', { outcome: 'helpful' }),
      e(13, 2 * 3_600_000, 'feedback', { outcome: 'helpful' }),
      e(14, 86_400_000, 'feedback', { outcome: 'helpful' }),
    ],
  }
}

/** 一个 run 由给定事件组成（时间以 T0 起算）。 */
function runOf(events: { ms: number; type: string; data: Record<string, unknown>; time?: string }[]): AgentRun {
  return {
    runId: RUN,
    parentRunId: null,
    chain: [RUN],
    events: events.map((item, index) => ({ runId: RUN, seq: index + 1, type: item.type, time: item.time ?? at(item.ms), data: item.data })),
  }
}

async function openDrawer(locale: 'en-GB' | 'zh-CN' = 'en-GB') {
  await renderHelpDesk(server, { role: 'FINANCE', path: `/${locale}/help-desk/a` })
  const [block] = await aiBlocks(locale === 'en-GB' ? 'AI Support Assistant' : 'AI 客服助手')
  fireEvent.click(within(block).getByRole('button', { name: locale === 'en-GB' ? 'View trace' : '查看链路' }))
  return screen.findByRole('dialog', { name: locale === 'en-GB' ? 'Agent trace' : '推荐链路' })
}

function assist(id: string): EnquiryDetail['aiAssist'][number] {
  return { id, source: 'chat', question: 'Q', faqId: FAQ_A, faqQuestion: 'FAQ', answer: `Answer ${id}`, feedback: null, createdAt: '2026-10-28T08:50:00Z' }
}

function serve(ticket: EnquiryDetail) {
  server.on('GET', LIST, { data: { tickets: [ticket], nextCursor: null, counts: {} } })
  server.on('GET', DETAIL, { data: ticket })
}

async function aiBlocks(name = 'AI Support Assistant') {
  return waitFor(() => {
    const blocks = screen.getAllByRole('region', { name })
    assert.ok(blocks.length > 0)
    return blocks
  })
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('View trace on AI blocks', () => {
  test('a VIEW role opens a read-only trace drawer for the block’s run', async () => {
    serve(detail('a', { aiAssist: [assist(RUN), assist(OTHER_RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: run() })
    await renderHelpDesk(server, { role: 'FINANCE', path: '/en-GB/help-desk/a' })
    const blocks = await aiBlocks()
    assert.equal(blocks.length, 2)
    for (const block of blocks) assert.ok(within(block).getByRole('button', { name: 'View trace' }))

    const opener = within(blocks[0]).getByRole('button', { name: 'View trace' })
    opener.focus()
    fireEvent.click(opener)
    const drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    assert.equal(server.callsTo('GET', `/api/helpdesk/agent-runs/${RUN}`).length, 1)

    // summary
    const summary = await waitFor(() => within(drawer).getByRole('group', { name: 'Summary' }))
    const value = (label: string) => {
      const term = within(summary).getByText(label, { selector: 'dt' })
      return term.nextElementSibling?.textContent ?? ''
    }
    assert.equal(value('End reason'), 'Answered')
    assert.equal(value('Model'), 'openai/gpt-4o-mini')
    assert.equal(value('Tokens'), '512 in / 9 out')
    assert.equal(value('Cost'), '$0.000082')
    assert.equal(value('Latency'), '910 ms')
    assert.equal(value('Chosen FAQ'), FAQ_A)
    assert.equal(value('Candidates'), `${FAQ_A}, ${FAQ_B}`)
    assert.equal(value('Trace ID'), '4bf92f3577b34da6a3ce929d0e0e4736')
    assert.equal(value('Conversation'), '2 runs in this conversation')

    // events: offset, type, step and details
    const list = within(drawer).getByRole('list', { name: 'Events' })
    const items = within(list).getAllByRole('listitem')
    assert.equal(items.length, 14)
    assert.match(items[0].textContent ?? '', /\+0 ms.*turn\/start/)
    assert.match(items[2].textContent ?? '', /\+40 ms.*step\/end.*Step 1 · retrieve.*Candidates.*0192f000-0000-7000-8000-000000000001/)
    assert.match(items[5].textContent ?? '', /\+900 ms.*assistant\/message.*openai\/gpt-4o-mini.*512 in \/ 9 out.*\$0\.000082/)
    assert.match(items[6].textContent ?? '', /tool\/call.*Tool arguments.*\{"faqId":"0192f000-0000-7000-8000-000000000001"\}/)
    assert.match(items[7].textContent ?? '', /tool\/result.*Error.*too_many_calls/)
    assert.match(items[9].textContent ?? '', /turn\/end.*End reason.*Answered/)
    // offsets read as ms, s, min, h and d (feedback can come a day later)
    assert.deepEqual(
      items.slice(10).map((item) => item.querySelector('.hdTraceOffset')?.textContent),
      ['+1.5 s', '+1 min', '+2 h', '+1 d'],
    )

    // read-only: nothing to type into or save, and no learner text
    assert.equal(drawer.querySelectorAll('input, textarea, select').length, 0)
    assert.deepEqual(
      within(drawer).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent),
      ['Close'],
    )
    assert.doesNotMatch(drawer.textContent ?? '', /redacted/)

    // the page behind is inert; Escape closes and gives focus back
    assert.ok(document.querySelector('.hdContentBody')?.hasAttribute('inert'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Agent trace' }), null))
    assert.equal(document.activeElement, opener)
  })

  test('FULL roles have it too; the close button closes it', async () => {
    serve(detail('a', { aiAssist: [assist(RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: run() })
    await renderHelpDesk(server, { role: 'ADMIN', path: '/en-GB/help-desk/a' })
    const [block] = await aiBlocks()
    fireEvent.click(within(block).getByRole('button', { name: 'View trace' }))
    const drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Agent trace' }), null))
  })

  test('a run with no trace says so; a failed load says it could not be loaded', async () => {
    serve(detail('a', { aiAssist: [assist(RUN), assist(OTHER_RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { status: 404, error: 'AGENT_RUN_NOT_FOUND' })
    server.on('GET', `/api/helpdesk/agent-runs/${OTHER_RUN}`, { status: 500, error: 'INTERNAL_ERROR' })
    await renderHelpDesk(server, { role: 'OPERATION_AI', path: '/en-GB/help-desk/a' })
    const blocks = await aiBlocks()
    fireEvent.click(within(blocks[0]).getByRole('button', { name: 'View trace' }))
    let drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    await waitFor(() => assert.ok(within(drawer).getByText('No trace was recorded for this answer.')))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Agent trace' }), null))
    fireEvent.click(within(blocks[1]).getByRole('button', { name: 'View trace' }))
    drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    await waitFor(() => assert.ok(within(drawer).getByText('The trace could not be loaded. Try again later.')))
  })

  test('zh-CN copy', async () => {
    serve(detail('a', { aiAssist: [assist(RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: run() })
    await renderHelpDesk(server, { role: 'FINANCE', path: '/zh-CN/help-desk/a' })
    const [block] = await aiBlocks('AI 客服助手')
    fireEvent.click(within(block).getByRole('button', { name: '查看链路' }))
    const drawer = await screen.findByRole('dialog', { name: '推荐链路' })
    const summary = await waitFor(() => within(drawer).getByRole('group', { name: '概要' }))
    assert.equal(within(summary).getByText('结束原因', { selector: 'dt' }).nextElementSibling?.textContent, '已答复')
    assert.equal(within(summary).getByText('Token', { selector: 'dt' }).nextElementSibling?.textContent, '输入 512 / 输出 9')
    assert.ok(within(drawer).getByRole('button', { name: '关闭' }))
  })

  test('zh-CN event list: steps, offsets and details', async () => {
    serve(detail('a', { aiAssist: [assist(RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: run() })
    const drawer = await openDrawer('zh-CN')
    const list = await waitFor(() => within(drawer).getByRole('list', { name: '事件' }))
    const items = within(list).getAllByRole('listitem')
    assert.match(items[2].textContent ?? '', /\+40 毫秒.*step\/end.*第 1 步 · retrieve.*候选/)
    assert.match(items[5].textContent ?? '', /\+900 毫秒.*assistant\/message.*输入 512 \/ 输出 9.*费用/)
    assert.match(items[7].textContent ?? '', /tool\/result.*错误.*too_many_calls/)
    assert.deepEqual(
      items.slice(10).map((item) => item.querySelector('.hdTraceOffset')?.textContent),
      ['+1.5 秒', '+1 分钟', '+2 小时', '+1 天'],
    )
  })

  test('shows the loading copy until the run arrives', async () => {
    serve(detail('a', { aiAssist: [assist(RUN)] }))
    const pending = deferred<Reply>()
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, () => pending.promise)
    const drawer = await openDrawer()
    assert.ok(within(drawer).getByText('Loading trace…'))
    pending.resolve({ data: run() })
    await waitFor(() => assert.ok(within(drawer).getByRole('group', { name: 'Summary' })))
    assert.equal(within(drawer).queryByText('Loading trace…'), null)
  })

  test('a run with no events shows dashes, not NaN; an unknown end reason shows as is; an unknown price says so', async () => {
    serve(detail('a', { aiAssist: [assist(RUN), assist(OTHER_RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: runOf([]) })
    server.on('GET', `/api/helpdesk/agent-runs/${OTHER_RUN}`, {
      data: {
        ...runOf([
          { ms: 0, type: 'turn/start', data: { turn: 1 } },
          { ms: 5, type: 'assistant/message', data: { turn: 1, step: 2, model: 'acme/new', usage: { inputTokens: 100, outputTokens: 10 }, costUsd: null } },
          { ms: 9, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c', name: 'pick_faq', rejectedArguments: { length: 57 } } },
          { ms: 0, type: 'turn/end', data: { turn: 1, reason: 'brand_new_reason' }, time: 'not a time' },
        ]),
        runId: OTHER_RUN,
        chain: [OTHER_RUN],
      },
    })
    await renderHelpDesk(server, { role: 'FINANCE', path: '/en-GB/help-desk/a' })
    const blocks = await aiBlocks()
    fireEvent.click(within(blocks[0]).getByRole('button', { name: 'View trace' }))
    let drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    let summary = await waitFor(() => within(drawer).getByRole('group', { name: 'Summary' }))
    for (const dd of summary.querySelectorAll('dd')) assert.match(dd.textContent ?? '', /^(—|1 runs in this conversation)$/)
    assert.equal(within(within(drawer).getByRole('list', { name: 'Events' })).queryAllByRole('listitem').length, 0)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Agent trace' }), null))

    fireEvent.click(within(blocks[1]).getByRole('button', { name: 'View trace' }))
    drawer = await screen.findByRole('dialog', { name: 'Agent trace' })
    summary = await waitFor(() => within(drawer).getByRole('group', { name: 'Summary' }))
    const value = (label: string) => within(summary).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
    assert.equal(value('End reason'), 'brand_new_reason')
    assert.equal(value('Cost'), 'Unknown')
    const items = within(within(drawer).getByRole('list', { name: 'Events' })).getAllByRole('listitem')
    assert.match(items[1].textContent ?? '', /Cost.*Unknown/)
    assert.match(items[2].textContent ?? '', /Rejected arguments.*57 characters hidden/)
    assert.equal(items[3].querySelector('.hdTraceOffset')?.textContent, '—')
    assert.doesNotMatch(drawer.textContent ?? '', /NaN/)
  })

  test('a failed load can be retried', async () => {
    serve(detail('a', { aiAssist: [assist(RUN)] }))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { status: 500, error: 'INTERNAL_ERROR' })
    const drawer = await openDrawer()
    await waitFor(() => assert.ok(within(drawer).getByText('The trace could not be loaded. Try again later.')))
    server.on('GET', `/api/helpdesk/agent-runs/${RUN}`, { data: run() })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Try again' }))
    await waitFor(() => assert.ok(within(drawer).getByRole('group', { name: 'Summary' })))
    assert.equal(server.callsTo('GET', `/api/helpdesk/agent-runs/${RUN}`).length, 2)
  })
})
