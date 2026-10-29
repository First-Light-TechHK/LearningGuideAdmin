import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import type { AgentRun } from '../src/backoffice/contracts/helpdesk'
import { traceView } from '../src/backoffice/lib/helpdeskTrace'

/**
 * 「查看链路」的数据整理（helpdesk-agent-v2-pi-dsh §2）：BackOffice 拿到的是导出副本
 *（dsh SessionEvent，学员原文已脱敏），这里只把它排成抽屉要显示的行与概要，不改任何值。
 */

const RUN = '0192eeee-0000-7000-8000-0000000000a1'
const ROOT = '0192eeee-0000-7000-8000-0000000000a0'
const FAQ_A = '0192f000-0000-7000-8000-000000000001'
const FAQ_B = '0192f000-0000-7000-8000-000000000002'
const T0 = Date.parse('2026-10-29T09:00:00.000Z')

function event(seq: number, ms: number, type: string, data: Record<string, unknown>) {
  return { runId: RUN, seq, type, time: new Date(T0 + ms).toISOString(), data }
}

function answeredRun(): AgentRun {
  return {
    runId: RUN,
    parentRunId: ROOT,
    chain: [ROOT, RUN],
    events: [
      event(1, 0, 'turn/start', {
        turn: 1,
        workflow: 'faq',
        source: 'chat',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        input: { redacted: true },
      }),
      event(2, 2, 'step/start', { turn: 1, step: 1, name: 'retrieve', kind: 'code' }),
      event(3, 40, 'step/end', {
        turn: 1,
        step: 1,
        name: 'retrieve',
        kind: 'code',
        then: { next: 'pick_faq' },
        output: { candidates: [{ id: FAQ_A, score: 0.9 }, { id: FAQ_B, score: 0.4 }] },
      }),
      event(4, 41, 'step/start', { turn: 1, step: 2, name: 'pick_faq', kind: 'agent', tools: ['pick_faq'] }),
      event(5, 42, 'request/context', { turn: 1, step: 2, provider: 'openrouter', model: 'openai/gpt-4o-mini', api: 'openai-completions' }),
      event(6, 42, 'request/header', { turn: 1, step: 2, reason: 'step', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01' }),
      event(7, 900, 'assistant/message', {
        turn: 1,
        step: 2,
        model: 'openai/gpt-4o-mini',
        usage: { inputTokens: 512, outputTokens: 9, cacheReadTokens: 0, reasoningTokens: 0 },
        costUsd: 0.0000822,
        stopReason: 'toolUse',
        toolCalls: 1,
        text: { redacted: true },
      }),
      event(8, 901, 'tool/call', { turn: 1, step: 2, callId: 'c1', name: 'pick_faq', arguments: `{"faqId":"${FAQ_A}"}` }),
      event(9, 902, 'tool/result', { turn: 1, step: 2, callId: 'c1', name: 'pick_faq', result: { faqId: FAQ_A } }),
      event(10, 903, 'step/end', {
        turn: 1,
        step: 2,
        name: 'pick_faq',
        kind: 'agent',
        outcome: 'called',
        args: { faqId: FAQ_A },
        then: { next: 'validate' },
      }),
      event(11, 904, 'step/start', { turn: 1, step: 3, name: 'validate', kind: 'code' }),
      event(12, 905, 'step/end', { turn: 1, step: 3, name: 'validate', kind: 'code', then: { next: 'answer' }, output: { faqId: FAQ_A, valid: true } }),
      event(13, 906, 'step/start', { turn: 1, step: 4, name: 'answer', kind: 'code' }),
      event(14, 906, 'step/end', { turn: 1, step: 4, name: 'answer', kind: 'code', then: { end: 'answered' }, output: { faqId: FAQ_A } }),
      event(15, 910, 'turn/end', { turn: 1, reason: 'answered', faqId: FAQ_A, model: 'openai/gpt-4o-mini', latencyMs: 910 }),
      event(16, 60_000, 'feedback', { outcome: 'helpful' }),
    ],
  }
}

describe('traceView', () => {
  test('summarises the run: end reason, model, tokens, cost, latency, chosen FAQ, candidates, trace id', () => {
    const view = traceView(answeredRun())
    assert.deepEqual(view.summary, {
      runId: RUN,
      parentRunId: ROOT,
      chainLength: 2,
      endReason: 'answered',
      model: 'openai/gpt-4o-mini',
      inputTokens: 512,
      outputTokens: 9,
      costUsd: 0.0000822,
      costUnknown: false,
      latencyMs: 910,
      chosenFaqId: FAQ_A,
      candidates: [FAQ_A, FAQ_B],
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      feedback: 'helpful',
    })
  })

  test('one row per event in seq order, with its time offset from the first event and what matters for its type', () => {
    const { rows } = traceView(answeredRun())
    assert.deepEqual(
      rows.map((row) => [row.seq, row.offsetMs, row.type, row.step, row.name]),
      [
        [1, 0, 'turn/start', null, null],
        [2, 2, 'step/start', 1, 'retrieve'],
        [3, 40, 'step/end', 1, 'retrieve'],
        [4, 41, 'step/start', 2, 'pick_faq'],
        [5, 42, 'request/context', 2, null],
        [6, 42, 'request/header', 2, null],
        [7, 900, 'assistant/message', 2, null],
        [8, 901, 'tool/call', 2, 'pick_faq'],
        [9, 902, 'tool/result', 2, 'pick_faq'],
        [10, 903, 'step/end', 2, 'pick_faq'],
        [11, 904, 'step/start', 3, 'validate'],
        [12, 905, 'step/end', 3, 'validate'],
        [13, 906, 'step/start', 4, 'answer'],
        [14, 906, 'step/end', 4, 'answer'],
        [15, 910, 'turn/end', null, null],
        [16, 60_000, 'feedback', null, null],
      ],
    )
    const byType = (seq: number) => rows.find((row) => row.seq === seq)?.details
    assert.deepEqual(byType(3), [{ kind: 'candidates', ids: [FAQ_A, FAQ_B] }])
    assert.deepEqual(byType(5), [{ kind: 'model', value: 'openai/gpt-4o-mini' }])
    assert.deepEqual(byType(7), [
      { kind: 'model', value: 'openai/gpt-4o-mini' },
      { kind: 'tokens', input: 512, output: 9 },
      { kind: 'cost', usd: 0.0000822 },
    ])
    assert.deepEqual(byType(8), [{ kind: 'toolArgs', value: `{"faqId":"${FAQ_A}"}` }])
    assert.deepEqual(byType(10), [{ kind: 'outcome', value: 'called' }, { kind: 'toolArgs', value: `{"faqId":"${FAQ_A}"}` }])
    assert.deepEqual(byType(12), [{ kind: 'chosen', faqId: FAQ_A }])
    assert.deepEqual(byType(15), [
      { kind: 'endReason', value: 'answered' },
      { kind: 'chosen', faqId: FAQ_A },
    ])
    assert.deepEqual(byType(16), [{ kind: 'feedback', value: 'helpful' }])
  })

  test('errors from a provider, a blocked tool call and a failed code step are shown', () => {
    const run: AgentRun = {
      runId: RUN,
      parentRunId: null,
      chain: [RUN],
      events: [
        event(1, 0, 'turn/start', { turn: 1, input: { redacted: true } }),
        event(2, 1, 'step/end', { turn: 1, step: 1, name: 'retrieve', kind: 'code', then: { end: 'error' }, error: { name: 'Error', code: 'step_failed' } }),
        event(3, 2, 'assistant/message', { turn: 1, step: 2, model: 'm', stopReason: 'error', error: { name: 'ProviderError', code: 'http_429' } }),
        event(4, 3, 'tool/result', { turn: 1, step: 2, callId: 'c2', name: 'pick_faq', error: { name: 'ToolError', code: 'too_many_calls' } }),
        event(5, 4, 'turn/end', { turn: 1, reason: 'error', faqId: null, model: null, latencyMs: 4 }),
      ],
    }
    const { rows, summary } = traceView(run)
    assert.deepEqual(rows[1].details, [{ kind: 'error', value: 'step_failed' }])
    assert.deepEqual(rows[2].details, [{ kind: 'model', value: 'm' }, { kind: 'error', value: 'http_429' }])
    assert.deepEqual(rows[3].details, [{ kind: 'error', value: 'too_many_calls' }])
    assert.deepEqual(rows[4].details, [{ kind: 'endReason', value: 'error' }])
    assert.equal(summary.endReason, 'error')
    assert.equal(summary.model, null)
    assert.equal(summary.inputTokens, null, 'no usage reported')
    assert.equal(summary.costUsd, null)
    assert.equal(summary.chosenFaqId, null)
    assert.deepEqual(summary.candidates, [])
    assert.equal(summary.feedback, null)
  })

  test('a run with no model step (no key, rate limited) still has its end reason; redacted learner text never becomes a value', () => {
    const view = traceView({
      runId: RUN,
      parentRunId: null,
      chain: [RUN],
      events: [
        event(1, 0, 'turn/start', { turn: 1, input: { redacted: true } }),
        event(2, 1, 'turn/end', { turn: 1, reason: 'no_key', faqId: null, model: null, latencyMs: 1 }),
      ],
    })
    assert.equal(view.summary.endReason, 'no_key')
    assert.equal(view.summary.latencyMs, 1)
    assert.deepEqual(view.rows[0].details, [])
    assert.ok(!JSON.stringify(view).includes('redacted'))
  })

  test('a rejected tool call shows only how long its hidden arguments were', () => {
    const { rows } = traceView({
      runId: RUN,
      parentRunId: null,
      chain: [RUN],
      events: [event(1, 0, 'tool/call', { turn: 1, step: 2, callId: 'c', name: 'pick_faq', rejectedArguments: { length: 57 } })],
    })
    assert.deepEqual(rows[0].details, [{ kind: 'rejectedArgs', length: 57 }])
  })

  test('an unknown price (costUsd null) is shown as unknown, never as a partial sum', () => {
    const { rows, summary } = traceView({
      runId: RUN,
      parentRunId: null,
      chain: [RUN],
      events: [
        event(1, 0, 'assistant/message', { turn: 1, step: 2, model: 'm', usage: { inputTokens: 100, outputTokens: 10 }, costUsd: null }),
        event(2, 5, 'assistant/message', { turn: 1, step: 3, model: 'm', usage: { inputTokens: 50, outputTokens: 5 }, costUsd: 0.001 }),
      ],
    })
    assert.deepEqual(rows[0].details, [
      { kind: 'model', value: 'm' },
      { kind: 'tokens', input: 100, output: 10 },
      { kind: 'cost', usd: null },
    ])
    assert.equal(summary.costUsd, null)
    assert.equal(summary.costUnknown, true)
    assert.equal(summary.inputTokens, 150)
  })

  test('an empty run and an unparsable time do not produce NaN', () => {
    const empty = traceView({ runId: RUN, parentRunId: null, chain: [RUN], events: [] })
    assert.deepEqual(empty.rows, [])
    assert.equal(empty.summary.endReason, null)
    assert.equal(empty.summary.costUnknown, false)
    const { rows } = traceView({
      runId: RUN,
      parentRunId: null,
      chain: [RUN],
      events: [event(1, 0, 'turn/start', { turn: 1 }), { runId: RUN, seq: 2, type: 'turn/end', time: 'not a time', data: { reason: 'error' } }],
    })
    assert.deepEqual(
      rows.map((row) => row.offsetMs),
      [0, null],
    )
  })
})
