import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * 锁住 Course 行（SELECT ... FOR UPDATE）：Set Live、切换测试版本与删除 Release
 * 都先拿这把锁再校验，避免并发时 Live / 测试指针指向刚被删除的版本（QA 2026-10-27 A7）。
 */
export async function lockCourseRow(tx: Tx, courseId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Course" WHERE id = ${courseId} FOR UPDATE`;
}

