import type { AgentRun, AgentRunEvent } from '../contracts/helpdesk'

/**
 * 「查看链路」抽屉的数据整理（helpdesk-agent-v2-pi-dsh §2）：把 run 的导出副本排成行与概要。
 * 只读、只挑要显示的字段，不改值；学员原文在服务端已换成 {redacted: true}，这里从不当作值显示。
 */

export type TraceDetail =
  | { kind: 'model'; value: string }
  | { kind: 'tokens'; input: number; output: number }
  | { kind: 'cost'; usd: number }
  | { kind: 'candidates'; ids: string[] }
  | { kind: 'chosen'; faqId: string }
  | { kind: 'toolArgs'; value: string }
  | { kind: 'outcome'; value: string }
  | { kind: 'error'; value: string }
  | { kind: 'endReason'; value: string }
  | { kind: 'feedback'; value: string }

export type TraceRow = {
  seq: number
  type: string
  /** 距第一条事件的毫秒数。 */
  offsetMs: number
  step: number | null
  name: string | null
  details: TraceDetail[]
}

export type TraceSummary = {
  runId: string
  parentRunId: string | null
  chainLength: number
  endReason: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  latencyMs: number | null
  chosenFaqId: string | null
  candidates: string[]
  traceId: string | null
  feedback: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function candidatesOf(data: Record<string, unknown>): string[] {
  const list = record(data.output)?.candidates
  if (!Array.isArray(list)) return []
  return list.map((item) => text(record(item)?.id)).filter((id): id is string => id !== null)
}

function errorOf(data: Record<string, unknown>): string | null {
  const error = record(data.error)
  return text(error?.code) ?? text(error?.name) ?? text(data.errorMessage)
}

function detailsOf(event: AgentRunEvent): TraceDetail[] {
  const data = event.data
  const out: TraceDetail[] = []
  const push = (detail: TraceDetail | null) => {
    if (detail) out.push(detail)
  }
  switch (event.type) {
    case 'step/end': {
      if (data.kind === 'agent') {
        const outcome = text(data.outcome)
        push(outcome ? { kind: 'outcome', value: outcome } : null)
        const args = record(data.args)
        push(args ? { kind: 'toolArgs', value: JSON.stringify(args) } : null)
      }
      const ids = candidatesOf(data)
      push(ids.length > 0 ? { kind: 'candidates', ids } : null)
      const chosen = text(record(data.output)?.faqId)
      push(chosen ? { kind: 'chosen', faqId: chosen } : null)
      const error = errorOf(data)
      push(error ? { kind: 'error', value: error } : null)
      break
    }
    case 'request/context': {
      const model = text(data.model)
      push(model ? { kind: 'model', value: model } : null)
      break
    }
    case 'assistant/message': {
      const model = text(data.model)
      push(model ? { kind: 'model', value: model } : null)
      const usage = record(data.usage)
      const input = count(usage?.inputTokens)
      const output = count(usage?.outputTokens)
      push(input !== null || output !== null ? { kind: 'tokens', input: input ?? 0, output: output ?? 0 } : null)
      const usd = count(data.costUsd)
      push(usd !== null ? { kind: 'cost', usd } : null)
      const error = text(data.errorMessage)
      push(error ? { kind: 'error', value: error } : null)
      break
    }
    case 'tool/call': {
      const args = text(data.arguments)
      push(args ? { kind: 'toolArgs', value: args } : null)
      break
    }
    case 'tool/result': {
      const error = errorOf(data)
      push(error ? { kind: 'error', value: error } : null)
      break
    }
    case 'turn/end': {
      const reason = text(data.reason)
      push(reason ? { kind: 'endReason', value: reason } : null)
      const chosen = text(data.faqId)
      push(chosen ? { kind: 'chosen', faqId: chosen } : null)
      break
    }
    case 'feedback': {
      const outcome = text(data.outcome)
      push(outcome ? { kind: 'feedback', value: outcome } : null)
      break
    }
  }
  return out
}

const NAMED = new Set(['step/start', 'step/end', 'tool/call', 'tool/result'])

export function traceView(run: AgentRun): { summary: TraceSummary; rows: TraceRow[] } {
  const events = [...run.events].sort((a, b) => a.seq - b.seq)
  const start = events.length > 0 ? Date.parse(events[0].time) : 0
  const rows = events.map((event) => ({
    seq: event.seq,
    type: event.type,
    offsetMs: Math.max(0, Date.parse(event.time) - start),
    step: count(event.data.step),
    name: NAMED.has(event.type) ? text(event.data.name) : null,
    details: detailsOf(event),
  }))

  const first = (type: string) => events.find((event) => event.type === type)?.data
  const end = first('turn/end')
  const messages = events.filter((event) => event.type === 'assistant/message').map((event) => event.data)
  const sum = (pick: (data: Record<string, unknown>) => number | null) => {
    const values = messages.map(pick).filter((value): value is number => value !== null)
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null
  }
  const retrieve = events.find((event) => event.type === 'step/end' && candidatesOf(event.data).length > 0)

  return {
    rows,
    summary: {
      runId: run.runId,
      parentRunId: run.parentRunId,
      chainLength: run.chain.length,
      endReason: text(end?.reason),
      model: text(end?.model) ?? text(first('request/context')?.model),
      inputTokens: sum((data) => count(record(data.usage)?.inputTokens)),
      outputTokens: sum((data) => count(record(data.usage)?.outputTokens)),
      costUsd: sum((data) => count(data.costUsd)),
      latencyMs: count(end?.latencyMs),
      chosenFaqId: text(end?.faqId),
      candidates: retrieve ? candidatesOf(retrieve.data) : [],
      traceId: text(first('turn/start')?.traceId),
      feedback: text(first('feedback')?.outcome),
    },
  }
}
