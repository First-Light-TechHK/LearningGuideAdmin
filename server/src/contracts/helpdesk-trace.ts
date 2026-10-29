/**
 * Helpdesk Agent 链路追踪的跨域契约（helpdesk-agent-v2-pi-dsh §2，照 DeepSeek Harness 的 SessionEvent）。
 *
 * - 日志 helpdesk_agent_events 归 Agent（agent 角色）写，只追加；
 * - BackOffice 的「查看链路」只经这里的 HelpdeskTraceSource 读，拿到的是导出副本（学员原文已脱敏）。
 * 具体实现由 app.module.ts 组装（两边互不 import 实现）。
 */
export const AGENT_EVENT_TYPES = [
  'turn/start',
  'step/start',
  'request/context',
  'request/header',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
  'feedback',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** turn/end.reason：一次推荐为什么结束。 */
export const TURN_END_REASONS = [
  'answered',
  'no_match',
  'no_candidates',
  'rate_limited',
  'timeout',
  'error',
  'aborted',
  'no_key',
] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** dsh SessionEvent 信封：run 内 seq 从 1 连续，time 是 ISO 8601（毫秒）。 */
export type AgentEventEnvelope = {
  type: AgentEventType;
  seq: number;
  time: string;
  data: JsonObject;
};

/** 导出副本里的一条：带去重键 (runId, seq)。 */
export type ExportedAgentEvent = AgentEventEnvelope & { runId: string };

export type TraceRun = {
  runId: string;
  /** 同一段对话的第一个 run（dsh parentSession）；自己就是第一个时为 null。 */
  parentRunId: string | null;
  /** 同一段对话里的全部 run（含自己），按时间先后。 */
  chain: string[];
  events: ExportedAgentEvent[];
};

export type TraceEventDetail = {
  event: ExportedAgentEvent;
  /** 导致它的事件（同一步里在它之前的，或整轮的开头）。 */
  sources: ExportedAgentEvent[];
  /** 由它引出的事件（同一步里在它之后的）。 */
  derived: ExportedAgentEvent[];
};

export const HELPDESK_TRACE_SOURCE = Symbol('HELPDESK_TRACE_SOURCE');

/** BackOffice 读链路（只读，导出副本）。 */
export interface HelpdeskTraceSource {
  readRun(runId: string): Promise<TraceRun | null>;
  traceEvent(runId: string, seq: number): Promise<TraceEventDetail | null>;
}
