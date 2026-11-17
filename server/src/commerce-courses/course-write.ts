import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { draftContentHash, versionContentHash } from './content-hash';

/**
 * 内容写入的唯一入口（一个用户动作 = 一个事务）。
 *
 * runCourseWrite 做四件事：开事务 → 锁住课程行（FOR UPDATE）→ 执行本次写入 → markDraftChanged。
 * 写入失败整个事务回滚，页面上已输入的内容由页面保留、可以重试；同一门课的两次写入排队执行，
 * 不会互相覆盖，也不会拿到同一个序号。
 */

export type CourseTx = Prisma.TransactionClient;

/** 草稿和线上版本内容一致时的状态：No draft，来源（导入/恢复）也一并清掉。 */
export const CLEARED_DRAFT = {
  hasDraft: false,
  lifecycleStatus: 'LIVE',
  draftSourceType: null,
  draftSourceEnvironment: null,
  draftSourceVersionLabel: null,
} as const;

/** 锁住课程行直到事务结束；课程不存在时返回 404。 */
export async function lockCourse(
  tx: CourseTx,
  courseId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException({
      code: 'COURSE_NOT_FOUND',
      message: 'Course not found',
    });
  }
}

/**
 * 内容改过之后决定草稿状态：
 * - 草稿和线上版本内容相同（改了又改回来）→ No draft，并清掉导入/恢复来源；
 * - 否则 hasDraft = true，导入/恢复来源保留，直到 Publish 或 Delete draft。
 * 在写入所在的事务里调用，所以结果马上可见，不靠下次打开页面时再去纠正。
 */
export async function markDraftChanged(
  tx: CourseTx,
  courseId: string,
): Promise<void> {
  const course = await tx.commerceCourse.findUnique({
    where: { id: courseId },
    select: { liveVersionId: true },
  });
  if (!course) {
    throw new NotFoundException({
      code: 'COURSE_NOT_FOUND',
      message: 'Course not found',
    });
  }
  if (course.liveVersionId) {
    const draft = await draftContentHash(tx, courseId);
    const live = await versionContentHash(tx, course.liveVersionId);
    if (live && draft === live) {
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: CLEARED_DRAFT,
      });
      return;
    }
  }
  await tx.commerceCourse.update({
    where: { id: courseId },
    data: { hasDraft: true, lifecycleStatus: 'WORKING' },
  });
}

export async function runCourseWrite<T>(
  prisma: PrismaService,
  courseId: string,
  write: (tx: CourseTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await lockCourse(tx, courseId);
      const result = await write(tx);
      await markDraftChanged(tx, courseId);
      return result;
    },
    { timeout: 60_000 },
  );
}
