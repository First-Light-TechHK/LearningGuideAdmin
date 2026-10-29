import { createMemoryAgentEventLog } from './agent-event.store';
import { RunTrace } from './run-trace';

const RUN = '0192eeee-0000-7000-8000-000000000010';

describe('RunTrace', () => {
  it('stamps each event when it happens, writes on flush, and numbers steps from 1', async () => {
    const log = createMemoryAgentEventLog();
    let now = Date.UTC(2026, 9, 29, 9, 0, 0, 0);
    const trace = new RunTrace(RUN, log, () => now);
    trace.emit('turn/start', { turn: 1, gone: undefined as never, nan: NaN });
    now += 250;
    expect(trace.nextStep()).toBe(1);
    expect(trace.nextStep()).toBe(2);
    trace.emit('turn/end', { turn: 1, reason: 'no_key' });
    expect(await log.read(RUN)).toEqual([]);
    await trace.flush();
    const events = await log.read(RUN);
    expect(events.map((e) => [e.seq, e.time])).toEqual([
      [1, '2026-10-29T09:00:00.000Z'],
      [2, '2026-10-29T09:00:00.250Z'],
    ]);
    // the stored data is exactly what JSON can hold
    expect(events[0].data).toEqual({ turn: 1, nan: null });
  });

  it('ignores events after turn/end (a late callback after a timeout)', async () => {
    const log = createMemoryAgentEventLog();
    const trace = new RunTrace(RUN, log);
    trace.emit('turn/end', { turn: 1, reason: 'timeout' });
    trace.emit('tool/call', { turn: 1, step: 2 });
    await trace.flush();
    expect((await log.read(RUN)).map((e) => e.type)).toEqual(['turn/end']);
  });

  it('refuses to continue somebody else’s run on the first write', async () => {
    const log = createMemoryAgentEventLog();
    await new RunTrace(RUN, log).flush(); // nothing buffered: no write
    const first = new RunTrace(RUN, log);
    first.emit('turn/start', { turn: 1 });
    await first.flush();
    const second = new RunTrace(RUN, log);
    second.emit('turn/start', { turn: 1 });
    await expect(second.flush()).rejects.toThrow(/already/);
    expect(await log.read(RUN)).toHaveLength(1);
  });
});
