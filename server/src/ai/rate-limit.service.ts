import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 限流来源：学员个人对话与直播间分开配额（2026-10-23）；
 * 后台 AI Tutor 测试对话单独一个桶，不占学员额度（QA 2026-10-27 A2）。
 */
export type AiRateLimitChannel = 'portal' | 'study-group' | 'admin-test';

/** 限流计数的存放处：滑动窗口内未满则记一次并返回 true，满了返回 false 且不记 */
export interface RateLimitStore {
  tryHit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** 单进程内存计数：只用于单元测试与本地单实例 */
export class MemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  tryHit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    const allowed = recent.length < limit;
    if (allowed) recent.push(now);
    this.hits.set(key, recent);
    return Promise.resolve(allowed);
  }
}

/**
 * 数据库计数（表 ai_rate_limit_hits）：多个 Agent 实例共用一份计数，扩容后限流仍然准确。
 * 同一 key 用事务级 advisory lock 串行，"数 + 记" 在一个事务里完成；顺手清掉窗口外的旧记录。
 */
@Injectable()
export class PrismaRateLimitStore implements RateLimitStore {
  constructor(private readonly prisma: PrismaService) {}

  tryHit(key: string, limit: number, windowMs: number): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await tx.$executeRaw`
        DELETE FROM ai_rate_limit_hits
        WHERE key = ${key}
          AND hit_at < now() - make_interval(secs => ${windowMs / 1000})`;
      const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ai_rate_limit_hits WHERE key = ${key}`;
      if (count >= limit) return false;
      await tx.$executeRaw`INSERT INTO ai_rate_limit_hits (key) VALUES (${key})`;
      return true;
    });
  }
}

/**
 * 简单限流（§4.4.3 / §2 红线：同一 courseId 每分钟最多 10 次 AI 请求）。
 * 直播间（study-group）单独一个桶，配额由 AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE
 * 配置（默认 30），不与学员个人对话互相挤占；后台测试（admin-test）同理，
 * 配额由 AI_RATE_LIMIT_ADMIN_TEST_PER_MINUTE 配置（默认 30）。
 * 计数放在 RateLimitStore 里；部署时用数据库实现，多实例共享（2026-10-24）。
 */
@Injectable()
export class RateLimitService {
  private static readonly LIMIT = 10;
  private static readonly STUDY_GROUP_LIMIT = 30;
  private static readonly ADMIN_TEST_LIMIT = 30;
  private static readonly WINDOW_MS = 60_000;

  constructor(private readonly store: RateLimitStore) {}

  private limitFor(channel: AiRateLimitChannel): number {
    if (channel === 'portal') return RateLimitService.LIMIT;
    const [envName, fallback] =
      channel === 'study-group'
        ? ['AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE', RateLimitService.STUDY_GROUP_LIMIT]
        : ['AI_RATE_LIMIT_ADMIN_TEST_PER_MINUTE', RateLimitService.ADMIN_TEST_LIMIT];
    const raw = Number.parseInt(process.env[envName]?.trim() || '', 10);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
  }

  async assertAllowed(
    courseId: string,
    channel: AiRateLimitChannel = 'portal',
  ): Promise<void> {
    const limit = this.limitFor(channel);
    const key = channel === 'portal' ? courseId : `${courseId}::${channel}`;
    if (await this.store.tryHit(key, limit, RateLimitService.WINDOW_MS)) return;
    throw new HttpException(
      `请求过于频繁，请稍后再试（每课程每分钟最多 ${limit} 次）`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
