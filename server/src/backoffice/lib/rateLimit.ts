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

/**
 * 固定窗口限流。单实例内存实现；
 * 多实例部署前需替换为共享存储（PRD PORT-SEC-005 已知限制）。
 */
export function consume(
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

/** 只查不计数：窗口内已达上限则返回 false。 */
export function peek(key: string, limit: number): RateLimitResult {
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

/** 清掉某个 key 的窗口（例如登录成功后清零失败计数）。 */
export function clear(key: string): void {
  buckets().delete(key);
}
