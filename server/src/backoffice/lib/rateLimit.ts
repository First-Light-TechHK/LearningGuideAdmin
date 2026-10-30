import { pool } from './db';

type Bucket = { count: number; resetsAt: number };

declare global {
  var __lgboRateBuckets: Map<string, Bucket> | undefined;
}

function buckets(): Map<string, Bucket> {
  if (!global.__lgboRateBuckets) global.__lgboRateBuckets = new Map();
  return global.__lgboRateBuckets;
}

/** 超过上限时清掉已过期的窗口，避免大量不同 key 让内存无限增长。 */
const SWEEP_THRESHOLD = 10_000;

function sweepExpired(now: number): void {
  const map = buckets();
  if (map.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of map) {
    if (bucket.resetsAt <= now) map.delete(key);
  }
}

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/** 固定窗口限流的进程内实现：Jest 与显式 BACKOFFICE_RATE_LIMIT_STORE=memory 时使用。 */
function consumeMemory(
  key: string,
  limit: number,
  windowMinutes: number,
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowMinutes * 60_000;
  sweepExpired(now);
  const existing = buckets().get(key);

  if (!existing || existing.resetsAt <= now) {
    buckets().set(key, { count: 1, resetsAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetsAt - now) / 1000),
      ),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: Math.ceil((existing.resetsAt - now) / 1000),
  };
}

function peekMemory(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets().get(key);
  if (!existing || existing.resetsAt <= now || existing.count < limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetsAt - now) / 1000)),
  };
}

function clearMemory(key: string): void {
  buckets().delete(key);
}

/**
 * 计数放哪：部署后放数据库表 backoffice_rate_limits，App Runner 扩到多个实例时
 * 共用一份计数（PRD PORT-SEC-005）；Jest 里继续用进程内计数，测试可直接操作窗口。
 */
function useMemoryStore(): boolean {
  if (process.env.BACKOFFICE_RATE_LIMIT_STORE?.trim() === 'memory') return true;
  if (process.env.BACKOFFICE_RATE_LIMIT_STORE?.trim() === 'db') return false;
  return Boolean(process.env.JEST_WORKER_ID);
}

function retryAfter(resetsAt: Date): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000));
}

/** 一条语句完成"过期则重开窗口、否则加一"，并发请求在行锁上排队，不会多放行。 */
const CONSUME_SQL = `
  INSERT INTO backoffice_rate_limits AS r (key, count, resets_at)
  VALUES ($1, 1, now() + make_interval(mins => $2))
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN r.resets_at <= now() THEN 1 ELSE r.count + 1 END,
    resets_at = CASE WHEN r.resets_at <= now() THEN now() + make_interval(mins => $2)
                     ELSE r.resets_at END
  RETURNING count, resets_at`;

/** 窗口内第 limit 次之后返回 allowed=false。 */
export async function consume(
  key: string,
  limit: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  if (useMemoryStore()) return consumeMemory(key, limit, windowMinutes);
  const { rows } = await pool().query<{ count: number; resets_at: Date }>(
    CONSUME_SQL,
    [key, windowMinutes],
  );
  const row = rows[0];
  // 偶尔顺手清掉早已过期的窗口，表不会无限增长
  if (Math.random() < 0.01) {
    void pool()
      .query(
        `DELETE FROM backoffice_rate_limits WHERE resets_at < now() - interval '1 hour'`,
      )
      .catch(() => undefined);
  }
  return {
    allowed: row.count <= limit,
    retryAfterSeconds: retryAfter(row.resets_at),
  };
}

/** 只查不计数：窗口内已达上限则返回 false。 */
export async function peek(
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  if (useMemoryStore()) return peekMemory(key, limit);
  const { rows } = await pool().query<{ count: number; resets_at: Date }>(
    `SELECT count, resets_at FROM backoffice_rate_limits WHERE key = $1 AND resets_at > now()`,
    [key],
  );
  const row = rows[0];
  if (!row || row.count < limit) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: retryAfter(row.resets_at) };
}

/** 清掉某个 key 的窗口（例如登录成功后清零失败计数）。 */
export async function clear(key: string): Promise<void> {
  if (useMemoryStore()) return clearMemory(key);
  await pool().query(`DELETE FROM backoffice_rate_limits WHERE key = $1`, [
    key,
  ]);
}
