type Bucket = { count: number; resetsAt: number };

declare global {
  var __lgboRateBuckets: Map<string, Bucket> | undefined;
}

function buckets(): Map<string, Bucket> {
  if (!global.__lgboRateBuckets) global.__lgboRateBuckets = new Map();
  return global.__lgboRateBuckets;
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
