import type { JsonObject } from '../../../contracts/helpdesk-trace';
import { createMemoryAgentEventLog } from './agent-event.store';
import { RunTrace } from './run-trace';
import { createTraceSource, exportEvents } from './trace-query';

/**
 * dsh sessionQuery 的对应：readRun = 整条时间线（导出副本），traceEvent = 一条事件的来源与派生。
 * 导出副本脱敏学员原文，带去重键 (runId, seq)；规范日志本身不动。
 */
const ROOT = '0192eeee-0000-7000-8000-000000000001';
const CHAT = '0192eeee-0000-7000-8000-000000000002';
const SUBMIT = '0192eeee-0000-7000-8000-000000000003';

async function seed() {
  const log = createMemoryAgentEventLog();
  let now = Date.UTC(2026, 9, 29, 9, 0, 0);
  const write = async (runId: string, parentRunId: string | null) => {
    const trace = new RunTrace(runId, log, () => (now += 10));
    trace.emit('turn/start', {
      turn: 1,
      parentRunId,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      input: { subject: '', message: 'my phone is 07700 900123' },
    });
    const one = trace.nextStep();
    trace.emit('step/start', { turn: 1, step: one, name: 'retrieve' });
    trace.emit('step/end', { turn: 1, step: one, name: 'retrieve' });
    const two = trace.nextStep();
    trace.emit('step/start', { turn: 1, step: two, name: 'pick_faq' });
    trace.emit('assistant/message', {
      turn: 1,
      step: two,
      text: 'repeats 07700 900123',
      stopReason: 'toolUse',
    });
    trace.emit('tool/call', {
      turn: 1,
      step: two,
      callId: 'c1',
      name: 'pick_faq',
      arguments: '{"faqId":"none"}',
    });
    trace.emit('tool/result', {
      turn: 1,
      step: two,
      callId: 'c1',
      result: { faqId: 'none' },
    });
    trace.emit('step/end', { turn: 1, step: two, name: 'pick_faq' });
    trace.emit('turn/end', { turn: 1, reason: 'no_match' });
    await trace.flush();
  };
  await write(ROOT, null);
  await write(CHAT, ROOT);
  await write(SUBMIT, ROOT);
  return { log, source: createTraceSource(log) };
}

describe('readRun', () => {
  it('returns the whole timeline with the dedupe key and the conversation chain', async () => {
    const { source } = await seed();
    const run = await source.readRun(CHAT);
    expect(run?.runId).toBe(CHAT);
    expect(run?.parentRunId).toBe(ROOT);
    expect(run?.chain).toEqual([ROOT, CHAT, SUBMIT]);
    expect(run?.events.map((e) => [e.runId, e.seq, e.type])).toEqual([
      [CHAT, 1, 'turn/start'],
      [CHAT, 2, 'step/start'],
      [CHAT, 3, 'step/end'],
      [CHAT, 4, 'step/start'],
      [CHAT, 5, 'assistant/message'],
      [CHAT, 6, 'tool/call'],
      [CHAT, 7, 'tool/result'],
      [CHAT, 8, 'step/end'],
      [CHAT, 9, 'turn/end'],
    ]);
    // the root run is its own conversation start
    expect((await source.readRun(ROOT))?.parentRunId).toBeNull();
    expect((await source.readRun(ROOT))?.chain).toEqual([ROOT, CHAT, SUBMIT]);
  });

  it('redacts learner text in the export and leaves the canonical log untouched', async () => {
    const { log, source } = await seed();
    const run = await source.readRun(CHAT);
    const text = JSON.stringify(run);
    expect(text).not.toContain('07700');
    expect(run?.events[0].data.input).toEqual({ redacted: true });
    expect(run?.events[4].data.text).toEqual({ redacted: true });
    const canonical = await log.read(CHAT);
    expect((canonical[0].data.input as JsonObject).message).toContain('07700');
  });

  it('returns null for a run with no events', async () => {
    const { source } = await seed();
    await expect(
      source.readRun('0192eeee-0000-7000-8000-0000000000ff'),
    ).resolves.toBeNull();
  });
});

describe('traceEvent', () => {
  it('links a tool result to what led to it and a step start to what it caused', async () => {
    const { source } = await seed();
    const result = await source.traceEvent(CHAT, 7);
    expect(result?.event.type).toBe('tool/result');
    expect(result?.sources.map((e) => e.seq)).toEqual([1, 4, 5, 6]);
    expect(result?.derived.map((e) => e.seq)).toEqual([8]);
    const start = await source.traceEvent(CHAT, 4);
    expect(start?.sources.map((e) => e.seq)).toEqual([1]);
    expect(start?.derived.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
  });

  it('treats the turn as the root: turn/start causes every step, turn/end follows them', async () => {
    const { source } = await seed();
    const start = await source.traceEvent(CHAT, 1);
    expect(start?.sources).toEqual([]);
    expect(start?.derived.map((e) => e.seq)).toEqual([2, 4]);
    const end = await source.traceEvent(CHAT, 9);
    expect(end?.sources.map((e) => e.seq)).toEqual([3, 8]);
    expect(end?.derived).toEqual([]);
  });

  it('is redacted too, and null for an unknown seq', async () => {
    const { source } = await seed();
    const reply = await source.traceEvent(CHAT, 5);
    expect(JSON.stringify(reply)).not.toContain('07700');
    await expect(source.traceEvent(CHAT, 99)).resolves.toBeNull();
    await expect(source.traceEvent(CHAT, 0)).resolves.toBeNull();
  });
});

describe('exportEvents', () => {
  it('drops nothing but the learner text', () => {
    expect(
      exportEvents(CHAT, [
        {
          type: 'feedback',
          seq: 10,
          time: '2026-10-29T09:00:00.000Z',
          data: { outcome: 'helpful' },
        },
        {
          type: 'turn/start',
          seq: 1,
          time: '2026-10-29T09:00:00.000Z',
          data: { turn: 1 },
        },
      ]),
    ).toEqual([
      {
        runId: CHAT,
        type: 'feedback',
        seq: 10,
        time: '2026-10-29T09:00:00.000Z',
        data: { outcome: 'helpful' },
      },
      {
        runId: CHAT,
        type: 'turn/start',
        seq: 1,
        time: '2026-10-29T09:00:00.000Z',
        data: { turn: 1 },
      },
    ]);
  });
});
