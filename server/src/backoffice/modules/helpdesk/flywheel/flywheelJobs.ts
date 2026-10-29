import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

import { uuidv7 } from '../../../../common/uuidv7';
import { pool, query, withTransaction } from '../../../lib/db';
import type { SqlClient, SqlDb } from '../faqs/faqRepository';

/**
 * 数据飞轮的后台任务（v5 Part G3「每晚、每天幂等」）：
 * - 进程内调度，不加任何运维配置（没有 cron、没有 AWS）：每个实例启动 2–3 分钟后第一次检查，之后每
 *   30 分钟一次；UTC 18 点（北京时间凌晨 2 点）之后才跑当天的定时运行；从不阻塞启动（定时器 unref）。
 * - 多实例安全：PostgreSQL 会话级 advisory lock（pg_try_advisory_lock(719320, 1)，在一条专用连接上
 *   持有到跑完）；拿不到锁 = 别的实例在跑，跳过。
 * - 每天幂等：helpdesk_flywheel_runs 上每个任务每个 UTC 日至多一行定时运行（部分唯一索引）。成功了当天不再跑；
 *   失败了下一次检查重试，一天至多 3 次；停在 running、心跳超过 30 分钟（实例死了）→ 接手。
 * - 可观察：每次运行一行（计数、状态、尝试次数、实例、耗时、错误码，从不含学员文字）+ 一行结构化日志
 *   （JSON，type "helpdesk"）。
 * - 员工「立即运行」：按 Idempotency-Key 幂等（同一个 key 回同一次运行；别的员工用这个 key → conflict），
 *   在后台跑，接口马上返回；拿不到锁 → already_running。
 */
export const FLYWHEEL_JOBS = ['gap_mining'] as const;
export type FlywheelJob = (typeof FLYWHEEL_JOBS)[number];
export const JOB_TRIGGERS = ['schedule', 'manual'] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];
export type JobStatus = 'running' | 'succeeded' | 'failed';

export const JOB_SCHEDULE = {
  firstTickMs: 120_000,
  firstTickJitterMs: 60_000,
  tickMs: 30 * 60_000,
  /** 当天的定时运行从这个 UTC 小时开始（北京时间凌晨 2 点）。 */
  startHourUtc: 18,
  maxAttempts: 3,
  /** 心跳超过这么久的 running 算实例死了，可以接手。 */
  staleMs: 30 * 60_000,
  heartbeatMs: 60_000,
} as const;

/** advisory lock 的两个键（与 Portal 的 719310 不同库，也不同号）。 */
export const FLYWHEEL_LOCK: readonly [number, number] = [719320, 1];

export type JobRun = {
  id: string;
  job: FlywheelJob;
  day: string;
  trigger: JobTrigger;
  status: JobStatus;
  attempts: number;
  instance: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stats: Record<string, unknown>;
  moreDue: boolean;
  errorCode: string | null;
  requestedBy: { id: string; name: string } | null;
};

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? new Date(value).toISOString()
      : null;

const COLUMNS = `id, job, run_day::text AS run_day, trigger, status, attempts, instance, started_at,
  heartbeat_at, finished_at, stats, more_due, error_code, requested_by, requested_by_name`;

function toRun(row: Row): JobRun {
  const started = iso(row.started_at) as string;
  const finished = iso(row.finished_at);
  return {
    id: row.id as string,
    job: row.job as FlywheelJob,
    day: row.run_day as string,
    trigger: row.trigger as JobTrigger,
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    instance: row.instance as string,
    startedAt: started,
    heartbeatAt: iso(row.heartbeat_at) as string,
    finishedAt: finished,
    durationMs: finished ? Date.parse(finished) - Date.parse(started) : null,
    stats: (row.stats as Record<string, unknown>) ?? {},
    moreDue: row.more_due === true,
    errorCode: (row.error_code as string | null) ?? null,
    requestedBy: row.requested_by
      ? {
          id: row.requested_by as string,
          name: (row.requested_by_name as string | null) ?? '',
        }
      : null,
  };
}

export type ClaimResult =
  | { kind: 'claimed'; run: JobRun; takeover: boolean }
  | { kind: 'done'; run: JobRun }
  | { kind: 'gave_up'; run: JobRun }
  | { kind: 'running'; run: JobRun };

export type ManualStart =
  | { kind: 'claimed'; run: JobRun }
  | { kind: 'existing'; run: JobRun }
  | { kind: 'conflict' };

async function lockedScheduled(
  client: SqlClient,
  job: FlywheelJob,
  day: string,
): Promise<JobRun | null> {
  const result = await client.query(
    `SELECT ${COLUMNS} FROM helpdesk_flywheel_runs
      WHERE job = $1 AND run_day = $2::date AND trigger = 'schedule' FOR UPDATE`,
    [job, day],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export function createPgJobRunRepository(db: SqlDb = defaultDb) {
  return {
    /** 定时运行：拿下当天这一行（新建、重试失败的、接手停住的），或说为什么不跑。 */
    async claimScheduled(input: {
      job: FlywheelJob;
      day: string;
      instance: string;
      now: Date;
      maxAttempts?: number;
      staleMs?: number;
    }): Promise<ClaimResult> {
      const maxAttempts = input.maxAttempts ?? JOB_SCHEDULE.maxAttempts;
      const staleMs = input.staleMs ?? JOB_SCHEDULE.staleMs;
      return db.withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO helpdesk_flywheel_runs (id, job, run_day, trigger, status, instance, started_at, heartbeat_at)
           VALUES ($1, $2, $3::date, 'schedule', 'running', $4, $5, $5)
           ON CONFLICT (job, run_day) WHERE trigger = 'schedule' DO NOTHING
           RETURNING ${COLUMNS}`,
          [uuidv7(), input.job, input.day, input.instance, input.now],
        );
        if (inserted.rows[0])
          return {
            kind: 'claimed',
            run: toRun(inserted.rows[0]),
            takeover: false,
          };
        const run = (await lockedScheduled(client, input.job, input.day))!;
        if (run.status === 'succeeded') return { kind: 'done', run };
        const stale =
          run.status === 'running' &&
          input.now.getTime() - Date.parse(run.heartbeatAt) > staleMs;
        if (run.status === 'running' && !stale) return { kind: 'running', run };
        if (run.attempts >= maxAttempts) {
          if (stale) {
            // 停住的最后一次：记成失败，当天不再试
            const failed = await client.query(
              `UPDATE helpdesk_flywheel_runs
                  SET status = 'failed', finished_at = $2, error_code = 'stale'
                WHERE id = $1 RETURNING ${COLUMNS}`,
              [run.id, input.now],
            );
            return { kind: 'gave_up', run: toRun(failed.rows[0]) };
          }
          return { kind: 'gave_up', run };
        }
        const restarted = await client.query(
          `UPDATE helpdesk_flywheel_runs
              SET status = 'running', attempts = attempts + 1, instance = $2, started_at = $3,
                  heartbeat_at = $3, finished_at = NULL, error_code = NULL, more_due = false,
                  stats = '{}'::jsonb
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [run.id, input.instance, input.now],
        );
        return {
          kind: 'claimed',
          run: toRun(restarted.rows[0]),
          takeover: stale,
        };
      });
    },

    /** 立即运行：同一个 key 回同一次运行（别的员工用这个 key → conflict），否则新建一行 running。 */
    async startManual(input: {
      job: FlywheelJob;
      day: string;
      instance: string;
      now: Date;
      idempotencyKey: string;
      employee: { id: string; name: string };
    }): Promise<ManualStart> {
      const inserted = await db.query(
        `INSERT INTO helpdesk_flywheel_runs
           (id, job, run_day, trigger, status, instance, started_at, heartbeat_at, requested_by,
            requested_by_name, idempotency_key)
         VALUES ($1, $2, $3::date, 'manual', 'running', $4, $5, $5, $6, $7, $8)
         ON CONFLICT (job, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          uuidv7(),
          input.job,
          input.day,
          input.instance,
          input.now,
          input.employee.id,
          input.employee.name.slice(0, 200),
          input.idempotencyKey,
        ],
      );
      if (inserted[0]) return { kind: 'claimed', run: toRun(inserted[0]) };
      const [existing] = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_flywheel_runs WHERE job = $1 AND idempotency_key = $2`,
        [input.job, input.idempotencyKey],
      );
      if (!existing) return { kind: 'conflict' };
      const run = toRun(existing);
      return run.requestedBy?.id === input.employee.id
        ? { kind: 'existing', run }
        : { kind: 'conflict' };
    },

    async byKey(job: FlywheelJob, key: string): Promise<JobRun | null> {
      const [row] = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_flywheel_runs WHERE job = $1 AND idempotency_key = $2`,
        [job, key],
      );
      return row ? toRun(row) : null;
    },

    async heartbeat(id: string, now: Date): Promise<void> {
      await db.query(
        `UPDATE helpdesk_flywheel_runs SET heartbeat_at = $2 WHERE id = $1 AND status = 'running'`,
        [id, now],
      );
    },

    async finish(input: {
      id: string;
      status: 'succeeded' | 'failed';
      now: Date;
      stats: Record<string, unknown>;
      moreDue: boolean;
      errorCode: string | null;
    }): Promise<JobRun> {
      const [row] = await db.query(
        `UPDATE helpdesk_flywheel_runs
            SET status = $2, finished_at = $3, heartbeat_at = $3, stats = $4::jsonb, more_due = $5,
                error_code = $6
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [
          input.id,
          input.status,
          input.now,
          JSON.stringify(input.stats),
          input.moreDue,
          input.errorCode,
        ],
      );
      return toRun(row);
    },

    async get(id: string): Promise<JobRun | null> {
      const [row] = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_flywheel_runs WHERE id = $1`,
        [id],
      );
      return row ? toRun(row) : null;
    },

    /** 最近的运行（新的先）。 */
    async list(job: FlywheelJob, limit: number): Promise<JobRun[]> {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_flywheel_runs WHERE job = $1
          ORDER BY started_at DESC, id DESC LIMIT $2`,
        [job, limit],
      );
      return rows.map(toRun);
    },
  };
}

export type JobRunRepository = ReturnType<typeof createPgJobRunRepository>;

/** 会话级 advisory lock：拿到就在同一条连接上跑完再放；拿不到 → acquired:false。 */
export type JobLock = {
  withLock<T>(
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
};

export function createPgJobLock(
  getPool: () => Pool = pool,
  key: readonly [number, number] = FLYWHEEL_LOCK,
): JobLock {
  return {
    async withLock(fn) {
      const client = await getPool().connect();
      let held = false;
      try {
        const result = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS ok',
          [key[0], key[1]],
        );
        held = result.rows[0]?.ok === true;
        if (!held) return { acquired: false };
        return { acquired: true, value: await fn() };
      } finally {
        if (held)
          await client
            .query('SELECT pg_advisory_unlock($1, $2)', [key[0], key[1]])
            .catch(() => undefined);
        client.release();
      }
    },
  };
}

export function instanceId(): string {
  return `${hostname().slice(0, 40)}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

/** 一次运行的工作：返回计数（只有数字与枚举）与是否还有没做完的（下次接着做）。 */
export type JobWork = (run: JobRun) => Promise<{
  stats: Record<string, unknown>;
  moreDue: boolean;
}>;

export type JobRunnerDeps = {
  runs: JobRunRepository;
  lock: JobLock;
  work: Record<FlywheelJob, JobWork>;
  instance?: string;
  now?: () => Date;
  logger?: Pick<Logger, 'log' | 'warn'>;
  heartbeatMs?: number;
};

/** 错误 → 错误码（只记码，不记文字：报错里可能有学员文字）。 */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code))
    return code;
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z0-9_]{1,64}$/.test(name) && name !== 'Error' ? name : 'error';
}

export type ScheduledOutcome =
  | { outcome: 'ran'; run: JobRun }
  | {
      outcome: 'skipped';
      reason: 'locked' | 'done' | 'gave_up' | 'running' | 'too_early';
    };

export type ManualOutcome =
  | { outcome: 'started'; run: JobRun; done: Promise<JobRun> }
  | { outcome: 'existing'; run: JobRun }
  | { outcome: 'already_running' }
  | { outcome: 'conflict' };

export function createJobRunner(deps: JobRunnerDeps) {
  const instance = deps.instance ?? instanceId();
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? new Logger('HelpdeskFlywheelJobs');
  const heartbeatMs = deps.heartbeatMs ?? JOB_SCHEDULE.heartbeatMs;
  const day = (at: Date) => at.toISOString().slice(0, 10);

  const log = (event: string, fields: Record<string, unknown>) =>
    logger.log(JSON.stringify({ type: 'helpdesk', event, ...fields }));

  /** 跑一次（已拿到锁与运行行）：心跳、工作、收尾、一行日志。 */
  async function execute(run: JobRun): Promise<JobRun> {
    const timer = setInterval(() => {
      void deps.runs.heartbeat(run.id, now()).catch(() => undefined);
    }, heartbeatMs);
    timer.unref?.();
    let finished: JobRun;
    try {
      const result = await deps.work[run.job](run);
      finished = await deps.runs.finish({
        id: run.id,
        status: 'succeeded',
        now: now(),
        stats: result.stats,
        moreDue: result.moreDue,
        errorCode: null,
      });
    } catch (error) {
      finished = await deps.runs.finish({
        id: run.id,
        status: 'failed',
        now: now(),
        stats: (error as { stats?: Record<string, unknown> }).stats ?? {},
        moreDue: false,
        errorCode: errorCode(error),
      });
    } finally {
      clearInterval(timer);
    }
    log('flywheel_job_run', {
      job: finished.job,
      runId: finished.id,
      day: finished.day,
      trigger: finished.trigger,
      status: finished.status,
      attempts: finished.attempts,
      durationMs: finished.durationMs,
      instance,
      moreDue: finished.moreDue,
      errorCode: finished.errorCode,
      stats: finished.stats,
    });
    return finished;
  }

  return {
    instance,

    /** 定时检查：到点了、拿到锁、当天还没成功（失败的重试至多 3 次）才跑。 */
    async runScheduled(job: FlywheelJob): Promise<ScheduledOutcome> {
      const at = now();
      if (at.getUTCHours() < JOB_SCHEDULE.startHourUtc)
        return { outcome: 'skipped', reason: 'too_early' };
      const locked = await deps.lock.withLock(async () => {
        const claim = await deps.runs.claimScheduled({
          job,
          day: day(at),
          instance,
          now: at,
        });
        if (claim.kind !== 'claimed') return claim;
        if (claim.takeover)
          log('flywheel_job_takeover', { job, runId: claim.run.id, instance });
        return { kind: 'ran' as const, run: await execute(claim.run) };
      });
      if (!locked.acquired) {
        log('flywheel_job_skipped', { job, reason: 'locked', instance });
        return { outcome: 'skipped', reason: 'locked' };
      }
      const value = locked.value;
      if (value.kind === 'ran') return { outcome: 'ran', run: value.run };
      if (value.kind === 'gave_up')
        log('flywheel_job_skipped', { job, reason: 'gave_up', instance });
      return { outcome: 'skipped', reason: value.kind };
    },

    /**
     * 员工「立即运行」：同一个 key 再来 → existing（同一次运行）；别的员工用这个 key → conflict；
     * 别的实例或别的运行正持有锁 → already_running（不留运行行）；否则马上返回 started，后台跑完。
     */
    async runNow(
      job: FlywheelJob,
      employee: { id: string; name: string },
      idempotencyKey: string,
    ): Promise<ManualOutcome> {
      const replay = await deps.runs.byKey(job, idempotencyKey);
      if (replay)
        return replay.requestedBy?.id === employee.id
          ? { outcome: 'existing', run: replay }
          : { outcome: 'conflict' };
      let started: (run: ManualOutcome) => void = () => undefined;
      const answer = new Promise<ManualOutcome>((resolve) => {
        started = resolve;
      });
      let settle: (run: JobRun) => void = () => undefined;
      let fail: (error: unknown) => void = () => undefined;
      const done = new Promise<JobRun>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      // 拿锁、建行、回答，然后在锁里接着跑完（锁一直持有到跑完）
      void deps.lock
        .withLock(async () => {
          const start = await deps.runs.startManual({
            job,
            day: day(now()),
            instance,
            now: now(),
            idempotencyKey,
            employee,
          });
          if (start.kind === 'conflict') {
            started({ outcome: 'conflict' });
            return;
          }
          if (start.kind === 'existing') {
            started({ outcome: 'existing', run: start.run });
            return;
          }
          started({ outcome: 'started', run: start.run, done });
          settle(await execute(start.run));
        })
        .then((result) => {
          if (!result.acquired) started({ outcome: 'already_running' });
        })
        .catch((error: unknown) => {
          fail(error);
          started({ outcome: 'already_running' });
        });
      done.catch(() => undefined);
      return answer;
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;

/**
 * 进程内的调度：start 之后 2–3 分钟第一次检查，之后每 30 分钟一次；定时器 unref（不拖住退出，
 * 也不阻塞启动）；一次检查出错只记一行日志。stop 停止之后的检查（正在跑的那次照样跑完）。
 */
export function startFlywheelScheduler(deps: {
  tick: () => Promise<unknown>;
  logger?: Pick<Logger, 'log' | 'warn'>;
  random?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => { unref?: () => unknown };
    clearTimeout: (handle: unknown) => void;
  };
}): { stop(): void } {
  const logger = deps.logger ?? new Logger('HelpdeskFlywheelJobs');
  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  const random = deps.random ?? Math.random;
  let stopped = false;
  let handle: { unref?: () => unknown } | null = null;
  const schedule = (ms: number) => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      void deps
        .tick()
        .catch((error: unknown) =>
          logger.warn(
            JSON.stringify({
              type: 'helpdesk',
              event: 'flywheel_job_tick_failed',
              errorCode: errorCode(error),
            }),
          ),
        )
        .finally(() => schedule(JOB_SCHEDULE.tickMs));
    }, ms);
    handle.unref?.();
  };
  schedule(
    JOB_SCHEDULE.firstTickMs +
      Math.floor(random() * JOB_SCHEDULE.firstTickJitterMs),
  );
  logger.log(
    JSON.stringify({ type: 'helpdesk', event: 'flywheel_jobs_started' }),
  );
  return {
    stop() {
      stopped = true;
      if (handle) timers.clearTimeout(handle);
    },
  };
}
