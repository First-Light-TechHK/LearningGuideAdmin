import type {
  AgentEventEnvelope,
  ExportedAgentEvent,
  HelpdeskTraceSource,
} from '../../../contracts/helpdesk-trace';
import { isUuid } from '../../../common/uuidv7';
import { LEARNER_TEXT_FIELDS, type AgentEventLog } from './agent-event.store';

/**
 * 链路查询（dsh sessionQuery 的 readSession / traceEvent）。给 BackOffice 的都是导出副本：
 * 学员原文换成 {redacted: true}，每条带去重键 (runId, seq)。
 */
export function exportEvents(
  runId: string,
  events: AgentEventEnvelope[],
): ExportedAgentEvent[] {
  return events.map((event) => {
    const field = LEARNER_TEXT_FIELDS[event.type];
    const data =
      field && field in event.data
        ? { ...event.data, [field]: { redacted: true } }
        : event.data;
    return { runId, ...event, data };
  });
}

const stepOf = (event: AgentEventEnvelope) =>
  typeof event.data.step === 'number' ? event.data.step : null;

export function createTraceSource(log: AgentEventLog): HelpdeskTraceSource {
  return {
    async readRun(rawRunId) {
      if (!isUuid(rawRunId)) return null;
      const runId = rawRunId.toLowerCase();
      const events = await log.read(runId);
      if (events.length === 0) return null;
      const start = events.find((e) => e.type === 'turn/start');
      const parent = start?.data.parentRunId;
      const parentRunId = typeof parent === 'string' ? parent : null;
      return {
        runId,
        parentRunId,
        chain: await log.chain(parentRunId ?? runId),
        events: exportEvents(runId, events),
      };
    },

    async traceEvent(rawRunId, seq) {
      if (!isUuid(rawRunId)) return null;
      const runId = rawRunId.toLowerCase();
      const events = await log.read(runId);
      const event = events.find((e) => e.seq === seq);
      if (!event) return null;
      const step = stepOf(event);
      let sources: AgentEventEnvelope[];
      let derived: AgentEventEnvelope[];
      if (step !== null) {
        const same = events.filter((e) => stepOf(e) === step);
        sources = [
          ...events.filter((e) => e.type === 'turn/start'),
          ...same.filter((e) => e.seq < seq),
        ];
        derived = same.filter((e) => e.seq > seq);
      } else if (event.type === 'turn/start') {
        sources = [];
        derived = events.filter((e) => e.type === 'step/start');
      } else if (event.type === 'turn/end') {
        sources = events.filter((e) => e.type === 'step/end');
        derived = events.filter((e) => e.type === 'feedback');
      } else {
        sources = events.filter((e) => e.type === 'turn/end');
        derived = [];
      }
      return {
        event: exportEvents(runId, [event])[0],
        sources: exportEvents(runId, sources),
        derived: exportEvents(runId, derived),
      };
    },
  };
}
