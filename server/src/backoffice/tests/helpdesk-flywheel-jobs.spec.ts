import type { AuditEventInput } from '../repositories/auditRepository';
import {
  JOB_SCHEDULE,
  errorCode,
  startFlywheelScheduler,
  type JobRun,
} from '../modules/helpdesk/flywheel/flywheelJobs';
import { createFlywheelRunsService } from '../modules/helpdesk/flywheel/flywheelRunsService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 进程内调度（v5 Part G3）：不阻塞启动（定时器 unref，第一次检查在 2–3 分钟后）、之后每 30 分钟、
 * 一次检查出错只记一行（错误码，不是文字）、stop 之后不再检查；员工的「立即运行」：必须带 key、
 * 正在跑 → 409、同 key 换人 → 422、都写审计（只有任务名与结果）。
 */
function fakeTimers() {
  const pending: { fn: () => void; ms: number; unref: jest.Mock }[] = [];
  return {
    pending,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const handle = { fn, ms, unref: jest.fn() };
        pending.push(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        const index = pending.indexOf(handle as (typeof pending)[number]);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    async fire() {
      const next = pending.shift();
      next?.fn();
      // tick 的 promise 链（tick → catch → finally → 下一次）
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

describe('in-process flywheel scheduler', () => {
  it('first checks 2-3 minutes after start (never during startup), then every 30 minutes; timers do not hold the process', async () => {
    const clock = fakeTimers();
    const tick = jest.fn(() => Promise.resolve());
    const scheduler = startFlywheelScheduler({
      tick,
      random: () => 0.5,
      timers: clock.timers,
      logger: { log: () => undefined, warn: () => undefined },
    });
    expect(tick).not.toHaveBeenCalled();
    expect(clock.pending[0].ms).toBe(
      JOB_SCHEDULE.firstTickMs + 0.5 * JOB_SCHEDULE.firstTickJitterMs,
    );
    expect(clock.pending[0].unref).toHaveBeenCalled();
    await clock.fire();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(clock.pending[0].ms).toBe(JOB_SCHEDULE.tickMs);
    scheduler.stop();
    expect(clock.pending).toHaveLength(0);
  });

  it('a failing check logs one structured line with an error code and keeps the schedule', async () => {
    const clock = fakeTimers();
    const warnings: string[] = [];
    startFlywheelScheduler({
      tick: () =>
        Promise.reject(
          Object.assign(new Error('learner said 13812345678'), {
            code: 'ECONNREFUSED',
          }),
        ),
      random: () => 0,
      timers: clock.timers,
      logger: {
        log: () => undefined,
        warn: (m: string) => warnings.push(m),
      },
    });
    await clock.fire();
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0])).toEqual({
      type: 'helpdesk',
      event: 'flywheel_job_tick_failed',
      errorCode: 'ECONNREFUSED',
    });
    expect(warnings[0]).not.toContain('1381');
    expect(clock.pending[0].ms).toBe(JOB_SCHEDULE.tickMs);
  });

  it('error codes never carry free text', () => {
    expect(errorCode(new Error('anything'))).toBe('error');
    expect(errorCode({ code: 'has spaces in it' })).toBe('error');
    expect(errorCode(new TypeError('x'))).toBe('TypeError');
    expect(errorCode({ code: 'HELPDESK_UNAVAILABLE' })).toBe(
      'HELPDESK_UNAVAILABLE',
    );
  });
});

describe('staff run-now for the flywheel and Portal retention jobs', () => {
  const EMP = {
    employeeId: '0192aaaa-0000-7000-8000-000000000001',
    displayName: 'Staff',
  };
  const KEY = '0192bbbb-0000-7000-8000-000000000001';
  const run = {
    id: '0192cccc-0000-7000-8000-000000000001',
    job: 'gap_mining',
  } as JobRun;

  function service(outcome: unknown, portalError?: Error) {
    const audits: AuditEventInput[] = [];
    const runner = { runNow: jest.fn(() => Promise.resolve(outcome)) };
    const portal = {
      assistRetentionRuns: jest.fn(),
      runAssistRetention: jest.fn(() =>
        portalError
          ? Promise.reject(portalError)
          : Promise.resolve({ outcome: 'completed' as const, run: null }),
      ),
    };
    return {
      audits,
      runner,
      portal,
      svc: createFlywheelRunsService({
        runs: { list: jest.fn(), get: jest.fn() },
        runner: runner as never,
        portal,
        audit: (event) => {
          audits.push(event);
          return Promise.resolve();
        },
      }),
    };
  }

  it('starts a run (201), replays the same key (200), refuses while running (409) or for another person (422), and audits', async () => {
    const started = service({
      outcome: 'started',
      run,
      done: Promise.resolve(run),
    });
    expect(await started.svc.runNow(EMP, 'gap_mining', KEY)).toEqual({
      run,
      created: true,
    });
    expect(started.runner.runNow).toHaveBeenCalledWith(
      'gap_mining',
      { id: EMP.employeeId, name: 'Staff' },
      KEY,
    );
    expect(started.audits).toEqual([
      expect.objectContaining({
        eventName: 'HELPDESK_JOB_RUN',
        action: 'run_now:gap_mining',
        result: 'SUCCESS',
        actorEmployeeId: EMP.employeeId,
      }),
    ]);
    expect(
      await service({ outcome: 'existing', run }).svc.runNow(
        EMP,
        'gap_mining',
        KEY,
      ),
    ).toEqual({ run, created: false });
    const busy = service({ outcome: 'already_running' });
    await expect(busy.svc.runNow(EMP, 'gap_mining', KEY)).rejects.toMatchObject(
      {
        status: 409,
        code: 'JOB_ALREADY_RUNNING',
      },
    );
    expect(busy.audits[0]).toMatchObject({ result: 'FAILURE' });
    await expect(
      service({ outcome: 'conflict' }).svc.runNow(EMP, 'gap_mining', KEY),
    ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      service({}).svc.runNow(EMP, 'gap_mining', undefined),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service({}).svc.runNow(EMP, 'nope', KEY),
    ).rejects.toMatchObject({
      status: 404,
      code: 'JOB_NOT_FOUND',
    });
  });

  it('forwards Portal retention run-now with the key and the signed-in employee, auditing success and failure', async () => {
    const ok = service({});
    expect(await ok.svc.runPortalRetention(EMP, KEY)).toEqual({
      outcome: 'completed',
      run: null,
    });
    expect(ok.portal.runAssistRetention).toHaveBeenCalledWith(
      { id: EMP.employeeId, name: 'Staff' },
      KEY,
    );
    expect(ok.audits[0]).toMatchObject({
      action: 'run_now:assist_retention',
      result: 'SUCCESS',
      newValue: 'completed',
    });
    const down = service(
      {},
      new HelpdeskError(502, 'HELPDESK_UNAVAILABLE', 'x'),
    );
    await expect(down.svc.runPortalRetention(EMP, KEY)).rejects.toMatchObject({
      code: 'HELPDESK_UNAVAILABLE',
    });
    expect(down.audits[0]).toMatchObject({
      result: 'FAILURE',
      newValue: 'HELPDESK_UNAVAILABLE',
    });
  });
});
