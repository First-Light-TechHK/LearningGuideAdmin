import { createMemoryAgentEventLog } from './agent-event.store';
import {
  assessModelHealth,
  healthThreshold,
  MODEL_HEALTH,
  modelHealthReport,
} from './model-health';
import { createTraceSource } from './trace-query';

const row = (over: Partial<Parameters<typeof assessModelHealth>[0][0]>) => ({
  step: 'explain',
  kind: 'agent' as const,
  total: 100,
  invalid: 0,
  guardFallbacks: 0,
  failures: 0,
  ...over,
});

describe('model output health', () => {
  const opts = { threshold: 0.05, minSample: 20 };

  it('alerts when any rate is above the threshold with enough calls', () => {
    const [invalid, guard, failure, ok] = assessModelHealth(
      [
        row({ invalid: 75 }),
        row({ guardFallbacks: 6 }),
        row({ failures: 6 }),
        row({ invalid: 5, guardFallbacks: 5, failures: 5 }),
      ],
      opts,
    );
    expect(invalid).toMatchObject({ invalidRate: 0.75, alert: true });
    expect(guard).toMatchObject({ guardFallbackRate: 0.06, alert: true });
    expect(failure).toMatchObject({ failureRate: 0.06, alert: true });
    // exactly at the threshold is not above it
    expect(ok).toMatchObject({ invalidRate: 0.05, alert: false });
  });

  it('never alerts on too few calls, and an empty step has rate 0', () => {
    const [few, none] = assessModelHealth(
      [row({ total: 19, invalid: 19 }), row({ total: 0 })],
      opts,
    );
    expect(few).toMatchObject({ invalidRate: 1, alert: false });
    expect(none).toMatchObject({ invalidRate: 0, alert: false });
  });

  it('reads the threshold from HELPDESK_MODEL_HEALTH_ALERT, falling back on bad values', () => {
    expect(healthThreshold({ HELPDESK_MODEL_HEALTH_ALERT: ' 0.1 ' })).toBe(0.1);
    for (const bad of ['', '0', '1', '-0.2', 'abc', '5%'])
      expect(healthThreshold({ HELPDESK_MODEL_HEALTH_ALERT: bad })).toBe(
        MODEL_HEALTH.threshold,
      );
    expect(healthThreshold({})).toBe(MODEL_HEALTH.threshold);
  });

  it('reports the last hours from the event log, through the trace source', async () => {
    const log = createMemoryAgentEventLog();
    const now = new Date(Date.UTC(2026, 10, 2, 12));
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
    await log.append('0192dddd-0000-7000-8000-000000000001', [
      {
        type: 'step/end',
        time: at(1),
        data: { name: 'explain', kind: 'agent', outcome: 'no_call' },
      },
      {
        type: 'step/end',
        time: at(30),
        data: { name: 'explain', kind: 'agent', outcome: 'called' },
      },
    ]);
    const day = await modelHealthReport(log, {
      hours: 24,
      now,
      threshold: 0.05,
    });
    expect(day).toEqual({
      since: at(24).toISOString(),
      hours: 24,
      threshold: 0.05,
      minSample: MODEL_HEALTH.minSample,
      steps: [
        {
          step: 'explain',
          kind: 'agent',
          total: 1,
          invalid: 1,
          guardFallbacks: 0,
          failures: 0,
          invalidRate: 1,
          guardFallbackRate: 0,
          failureRate: 0,
          alert: false,
        },
      ],
    });
    const source = createTraceSource(log, {
      now: () => now,
      env: { HELPDESK_MODEL_HEALTH_ALERT: '0.2' },
    });
    const week = await source.modelHealth(48);
    expect(week.threshold).toBe(0.2);
    expect(week.steps[0].total).toBe(2);
  });
});
