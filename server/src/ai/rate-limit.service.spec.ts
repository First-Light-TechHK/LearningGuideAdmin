import { HttpException, HttpStatus } from '@nestjs/common';
import { MemoryRateLimitStore, RateLimitService } from './rate-limit.service';

const create = () => new RateLimitService(new MemoryRateLimitStore());

/** §4.4.3 / §2 红线：同一 courseId 每分钟最多 10 次 */
describe('RateLimitService', () => {
  it('第 11 次请求抛 429，不同 courseId 互不影响', async () => {
    const svc = create();
    for (let i = 0; i < 10; i++) {
      await expect(svc.assertAllowed('course-a')).resolves.toBeUndefined();
    }
    await expect(svc.assertAllowed('course-a')).rejects.toThrow(HttpException);
    await svc.assertAllowed('course-a').catch((e: HttpException) => {
      expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });
    await expect(svc.assertAllowed('course-b')).resolves.toBeUndefined();
  });

  it('窗口滑出后恢复配额（fake timers）', async () => {
    jest.useFakeTimers();
    try {
      const svc = create();
      for (let i = 0; i < 10; i++) await svc.assertAllowed('course-a');
      await expect(svc.assertAllowed('course-a')).rejects.toThrow(
        HttpException,
      );
      jest.advanceTimersByTime(61_000);
      await expect(svc.assertAllowed('course-a')).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('直播间槽位独立：不与学员个人对话共享配额', async () => {
    const svc = create();
    for (let i = 0; i < 10; i++) await svc.assertAllowed('course-a');
    await expect(svc.assertAllowed('course-a')).rejects.toThrow(HttpException);
    // The Live Room keeps its own bucket, so the exhausted 1:1 quota does not
    // stop the room.
    for (let i = 0; i < 30; i++) {
      await expect(
        svc.assertAllowed('course-a', 'study-group'),
      ).resolves.toBeUndefined();
    }
    await expect(svc.assertAllowed('course-a', 'study-group')).rejects.toThrow(
      HttpException,
    );
  });

  it('直播间配额可由 AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE 覆盖', async () => {
    const previous = process.env.AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE;
    process.env.AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE = '2';
    try {
      const svc = create();
      await svc.assertAllowed('course-a', 'study-group');
      await svc.assertAllowed('course-a', 'study-group');
      await expect(
        svc.assertAllowed('course-a', 'study-group'),
      ).rejects.toThrow(HttpException);
      // An invalid value keeps the default, never disables the gate.
      process.env.AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE = 'not-a-number';
      const fallback = create();
      for (let i = 0; i < 30; i++)
        await fallback.assertAllowed('course-b', 'study-group');
      await expect(
        fallback.assertAllowed('course-b', 'study-group'),
      ).rejects.toThrow(HttpException);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE;
      } else {
        process.env.AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE = previous;
      }
    }
  });

  it('被拒绝的请求不计数：配额只算放行的次数', async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.tryHit('k', 1, 60_000)).toBe(true);
    expect(await store.tryHit('k', 1, 60_000)).toBe(false);
    expect(await store.tryHit('k', 2, 60_000)).toBe(true);
  });
});
