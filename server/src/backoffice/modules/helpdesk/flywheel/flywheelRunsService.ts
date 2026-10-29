import { isUuid } from '../../../../common/uuidv7';
import type { AuditEventInput } from '../../../repositories/auditRepository';
import type { PortalJobRunResult, PortalJobRuns } from '../contracts';
import {
  HelpdeskError,
  type PortalHelpdeskClient,
} from '../portalHelpdeskClient';
import {
  FLYWHEEL_JOBS,
  type FlywheelJob,
  type JobRun,
  type JobRunRepository,
  type JobRunner,
} from './flywheelJobs';

/**
 * 员工端的后台任务（v5 Part G3「立即运行」与 Portal 的保留任务）：
 * - Admin 的夜间缺口挖掘：最近的运行（运行行：状态、计数、耗时、错误码、谁触发的），「立即运行」
 *   必须带 Idempotency-Key（UUID）：同一个员工同一个 key → 同一次运行；正在跑 → 409 JOB_ALREADY_RUNNING。
 * - Portal 的学员原文保留任务（assist_retention，180 天后只留脱敏文字与标签）：经集成接口读运行记录、
 *   「立即运行」（Portal 自己加锁与幂等；Admin 只转发 key 与当前员工）。
 * 两种「立即运行」都写审计（audit_events，只有任务名与结果，没有任何文字）。
 */

export type Employee = { employeeId: string; displayName?: string | null };

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function key(raw: string | undefined): string {
  if (!raw || !isUuid(raw))
    throw invalid('Idempotency-Key (a UUID) is required');
  return raw.toLowerCase();
}

function job(raw: string): FlywheelJob {
  if (!(FLYWHEEL_JOBS as readonly string[]).includes(raw))
    throw new HelpdeskError(404, 'JOB_NOT_FOUND', 'Unknown job');
  return raw as FlywheelJob;
}

export function createFlywheelRunsService(deps: {
  runs: Pick<JobRunRepository, 'list' | 'get'>;
  runner: Pick<JobRunner, 'runNow'>;
  portal: Pick<
    PortalHelpdeskClient,
    'assistRetentionRuns' | 'runAssistRetention'
  >;
  audit: (event: AuditEventInput) => Promise<void>;
}) {
  const audit = (
    employee: Employee,
    action: string,
    result: AuditEventInput['result'],
    newValue: string,
  ) =>
    deps.audit({
      eventName: 'HELPDESK_JOB_RUN',
      actorEmployeeId: employee.employeeId,
      targetEmployeeId: null,
      action,
      newValue,
      result,
    });

  return {
    async list(rawJob: string): Promise<{ runs: JobRun[] }> {
      return { runs: await deps.runs.list(job(rawJob), 30) };
    },

    async get(rawJob: string, rawId: string): Promise<JobRun> {
      job(rawJob);
      if (!isUuid(rawId)) throw invalid('Invalid run id');
      const run = await deps.runs.get(rawId.toLowerCase());
      if (!run || run.job !== rawJob)
        throw new HelpdeskError(404, 'JOB_RUN_NOT_FOUND', 'Run not found');
      return run;
    },

    /** 201 新开了一次运行（后台跑，轮询 GET 看结果）；200 同一个 key 的那一次。 */
    async runNow(
      employee: Employee,
      rawJob: string,
      rawKey: string | undefined,
    ): Promise<{ run: JobRun; created: boolean }> {
      const which = job(rawJob);
      const idempotencyKey = key(rawKey);
      const outcome = await deps.runner.runNow(
        which,
        { id: employee.employeeId, name: employee.displayName ?? '' },
        idempotencyKey,
      );
      switch (outcome.outcome) {
        case 'started':
          await audit(employee, `run_now:${which}`, 'SUCCESS', outcome.run.id);
          return { run: outcome.run, created: true };
        case 'existing':
          return { run: outcome.run, created: false };
        case 'already_running':
          await audit(
            employee,
            `run_now:${which}`,
            'FAILURE',
            'already_running',
          );
          throw new HelpdeskError(
            409,
            'JOB_ALREADY_RUNNING',
            'This job is already running. Try again when it has finished.',
          );
        default:
          throw new HelpdeskError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used for another run',
          );
      }
    },

    portalRetentionRuns(): Promise<PortalJobRuns> {
      return deps.portal.assistRetentionRuns();
    },

    async runPortalRetention(
      employee: Employee,
      rawKey: string | undefined,
    ): Promise<PortalJobRunResult> {
      const idempotencyKey = key(rawKey);
      try {
        const result = await deps.portal.runAssistRetention(
          { id: employee.employeeId, name: employee.displayName ?? '' },
          idempotencyKey,
        );
        await audit(
          employee,
          'run_now:assist_retention',
          'SUCCESS',
          result.outcome,
        );
        return result;
      } catch (error) {
        await audit(
          employee,
          'run_now:assist_retention',
          'FAILURE',
          error instanceof HelpdeskError ? error.code : 'error',
        );
        throw error;
      }
    },
  };
}

export type FlywheelRunsService = ReturnType<typeof createFlywheelRunsService>;
