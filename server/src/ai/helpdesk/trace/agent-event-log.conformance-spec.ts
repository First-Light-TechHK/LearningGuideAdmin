import { uuidv7 } from '../../../common/uuidv7';
import type { AgentEventLog, NewAgentEvent } from './agent-event.store';

/**
 * AgentEventLog 的共同约定（内存实现与 PostgreSQL 实现各跑一遍）：
 * seq 从 1 连续、并发追加也不跳号不重号；信封 {type, seq, time, data} 原样无损；
 * fresh 追加要求 run 还没有事件；只能追加，没有改写路径（除了 90 天清学员原文）。
 */
export function describeAgentEventLog(
  name: string,
  makeLog: () => AgentEventLog | Promise<AgentEventLog>,
  describeFn: jest.Describe = describe,
) {
  describeFn(`${name}: append-only SessionEvent log`, () => {
    let log: AgentEventLog;
    beforeAll(async () => {
      log = await makeLog();
    });

    const at = (ms: number) => new Date(Date.UTC(2026, 9, 29, 8, 0, 0, ms));
    function event(
      type: NewAgentEvent['type'],
      data: NewAgentEvent['data'],
      ms = 0,
    ): NewAgentEvent {
      return { type, time: at(ms), data };
    }

    it('numbers events from 1 without gaps and keeps them losslessly', async () => {
      const runId = uuidv7();
      const data = {
        turn: 1,
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        nested: { list: [1, 'two', null, true, { deep: '中文 ✓' }] },
        float: 0.000123,
        input: { subject: 'Cannot log in', message: 'line 1\nline 2' },
      };
      await log.append(runId, [
        event('turn/start', data, 1),
        event('step/start', { turn: 1, step: 1 }, 2),
      ]);
      await log.append(runId, [
        event('turn/end', { turn: 1, reason: 'no_match' }, 3),
      ]);
      const events = await log.read(runId);
      expect(events).toEqual([
        { type: 'turn/start', seq: 1, time: at(1).toISOString(), data },
        {
          type: 'step/start',
          seq: 2,
          time: at(2).toISOString(),
          data: { turn: 1, step: 1 },
        },
        {
          type: 'turn/end',
          seq: 3,
          time: at(3).toISOString(),
          data: { turn: 1, reason: 'no_match' },
        },
      ]);
      await expect(log.read(uuidv7())).resolves.toEqual([]);
    });

    it('keeps seq contiguous when many writers append to one run at once', async () => {
      const runId = uuidv7();
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          log.append(runId, [
            event('feedback', { outcome: 'helpful', writer: i }, i),
            event(
              'feedback',
              { outcome: 'helpful', writer: i, second: true },
              i,
            ),
          ]),
        ),
      );
      const events = await log.read(runId);
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: 24 }, (_, i) => i + 1),
      );
      // each writer's batch stays together and in order
      for (let i = 0; i < events.length; i += 2) {
        expect(events[i].data.writer).toBe(events[i + 1].data.writer);
        expect(events[i + 1].data.second).toBe(true);
      }
    });

    it('refuses a fresh run whose id already has events, and changes nothing', async () => {
      const runId = uuidv7();
      await log.append(runId, [event('turn/start', { turn: 1 })], {
        fresh: true,
      });
      await expect(
        log.append(runId, [event('turn/start', { turn: 1, again: true })], {
          fresh: true,
        }),
      ).rejects.toThrow(/already/);
      expect(await log.read(runId)).toHaveLength(1);
    });

    it('appends to an existing run only, when asked (feedback never starts a run)', async () => {
      const runId = uuidv7();
      await expect(
        log.append(runId, [event('feedback', { outcome: 'helpful' })], {
          existing: true,
        }),
      ).rejects.toThrow(/no events/);
      expect(await log.read(runId)).toEqual([]);
      await log.append(runId, [event('turn/start', { turn: 1 })], {
        fresh: true,
      });
      await log.append(runId, [event('feedback', { outcome: 'helpful' })], {
        existing: true,
      });
      expect((await log.read(runId)).map((e) => [e.seq, e.type])).toEqual([
        [1, 'turn/start'],
        [2, 'feedback'],
      ]);
    });

    it('lists the runs of one conversation by their parent, oldest first', async () => {
      const root = uuidv7();
      const second = uuidv7();
      const third = uuidv7();
      const other = uuidv7();
      await log.append(root, [
        event('turn/start', { turn: 1, parentRunId: null }, 1),
      ]);
      await log.append(third, [
        event('turn/start', { turn: 1, parentRunId: root }, 3),
      ]);
      await log.append(second, [
        event('turn/start', { turn: 1, parentRunId: root }, 2),
      ]);
      await log.append(other, [
        event('turn/start', { turn: 1, parentRunId: null }, 4),
      ]);
      await expect(log.chain(root)).resolves.toEqual([root, second, third]);
      await expect(log.chain(other)).resolves.toEqual([other]);
    });

    it('after 90 days clears only the learner text fields, nothing else', async () => {
      const old = uuidv7();
      const fresh = uuidv7();
      const start = {
        turn: 1,
        source: 'chat',
        input: { subject: '', message: 'my email is a@b.c' },
      };
      const reply = {
        turn: 1,
        step: 2,
        text: 'echo of the learner',
        usage: { inputTokens: 1 },
      };
      await log.append(old, [
        {
          type: 'turn/start',
          time: new Date('2026-01-01T00:00:00Z'),
          data: start,
        },
        {
          type: 'assistant/message',
          time: new Date('2026-01-01T00:00:01Z'),
          data: reply,
        },
        {
          type: 'turn/end',
          time: new Date('2026-01-01T00:00:02Z'),
          data: { turn: 1, reason: 'no_match' },
        },
      ]);
      await log.append(fresh, [
        {
          type: 'turn/start',
          time: new Date('2026-10-01T00:00:00Z'),
          data: start,
        },
      ]);
      const cleared = await log.purgeLearnerText(
        new Date('2026-08-01T00:00:00Z'),
      );
      expect(cleared).toBe(2);
      const events = await log.read(old);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(events[0].data).toEqual({ turn: 1, source: 'chat' });
      expect(events[1].data).toEqual({
        turn: 1,
        step: 2,
        usage: { inputTokens: 1 },
      });
      expect(events[2].data).toEqual({ turn: 1, reason: 'no_match' });
      expect((await log.read(fresh))[0].data).toEqual(start);
      await expect(
        log.purgeLearnerText(new Date('2026-08-01T00:00:00Z')),
      ).resolves.toBe(0);
    });
  });
}
