import type { Prisma } from '@prisma/client';

/**
 * 课程模块里所有给人看的编号的格式（PRD L132-L142 ID 表、L759）。
 * 这里是纯函数部分：格式化与解析。数据库计数器（allocate / raise）在同一个文件的下半部分。
 *
 * | 对象 | 格式 | 唯一范围 |
 * |---|---|---|
 * | Course ID | C001 | 全局 |
 * | Lesson ID | L001 | Course 内 |
 * | Exhibit ID | E001 | Course 内 |
 * | 知识题 | K-0201（K- + 课时号 + 序号，各至少两位） | Course 内 |
 * | 应用题 | A-0201 | Course 内 |
 * | 学习点 | V1、T1（视频 / 文本，按课时+语言分别计数） | 课时+语言+来源 |
 */

function pad(n: number, width: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(width, '0');
}

export function formatCourseCode(n: number): string {
  return `C${pad(n, 3)}`;
}

export function formatLessonCode(n: number): string {
  return `L${pad(n, 3)}`;
}

export function formatExhibitCode(n: number): string {
  return `E${pad(n, 3)}`;
}

/** 课时号：课时编号结尾的数字（L003、L3 都是 3）；没有数字时用 fallback（课时位置）。 */
export function lessonNumber(code: string, fallback = 0): number {
  const match = /(\d{1,9})$/.exec(code);
  return match ? Number(match[1]) : fallback;
}

export function formatKnowledgeCode(
  lessonNo: number,
  sequence: number,
): string {
  return `K-${pad(lessonNo, 2)}${pad(sequence, 2)}`;
}

export function formatApplicationCode(
  lessonNo: number,
  sequence: number,
): string {
  return `A-${pad(lessonNo, 2)}${pad(sequence, 2)}`;
}

export type LearningPointSource = 'VIDEO' | 'TEXT';

export function formatLearningPointCode(
  source: LearningPointSource,
  n: number,
): string {
  return `${source === 'VIDEO' ? 'V' : 'T'}${Math.max(1, Math.trunc(n))}`;
}

// ===== 计数器（CourseCodeCounter）=====

/** PrismaService 与事务客户端都满足；分配必须在调用方的事务里做，写入失败时编号一起回滚。 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'commerceCourse'>;

export const COURSE_COUNTER_KEY = 'course';
export const lessonCounterKey = (courseId: string) => `lesson:${courseId}`;
export const exhibitCounterKey = (courseId: string) => `exhibit:${courseId}`;
export const knowledgeCounterKey = (lessonId: string) =>
  `knowledge:${lessonId}`;
export const applicationCounterKey = (lessonId: string) =>
  `application:${lessonId}`;
export const learningPointCounterKey = (
  lessonId: string,
  language: string,
  source: LearningPointSource,
) => `lp:${lessonId}:${language}:${source === 'VIDEO' ? 'V' : 'T'}`;

/**
 * 取下一个编号。一条原子语句：键不存在时返回 1 并把计数器记成 2；存在时加一并返回加之前的值。
 * 计数器只增不减，所以删除后的编号不会再发出去（PRD ID 表"删除后不复用"）。
 */
export async function allocate(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  key: string,
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    INSERT INTO "CourseCodeCounter" ("key", "next") VALUES (${key}, 2)
    ON CONFLICT ("key") DO UPDATE SET "next" = "CourseCodeCounter"."next" + 1
    RETURNING "next" - 1 AS n`;
  return Number(rows[0].n);
}

/** 导入或恢复带来一个已有编号时调用：计数器至少越过它，之后不会再发出同一个编号。 */
export async function raise(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  key: string,
  used: number,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "CourseCodeCounter" ("key", "next") VALUES (${key}, ${used + 1})
    ON CONFLICT ("key") DO UPDATE
    SET "next" = GREATEST("CourseCodeCounter"."next", ${used + 1})`;
}

/**
 * 下一个 Course ID：只看不占（创建对话框显示用）。已被包导入占用的编号会跳过。
 */
export async function peekCourseCode(
  db: Pick<Prisma.TransactionClient, '$queryRaw' | 'commerceCourse'>,
): Promise<string> {
  const rows = await db.$queryRaw<Array<{ next: number }>>`
    SELECT "next" FROM "CourseCodeCounter" WHERE "key" = ${COURSE_COUNTER_KEY}`;
  let n = Number(rows[0]?.next ?? 1);
  for (;;) {
    const code = formatCourseCode(n);
    const taken = await db.commerceCourse.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!taken) return code;
    n += 1;
  }
}

/** 分配下一个 Course ID，跳过已被占用的编号（包导入带来的编号）。 */
export async function allocateCourseCode(db: Db): Promise<string> {
  for (;;) {
    const code = formatCourseCode(await allocate(db, COURSE_COUNTER_KEY));
    const taken = await db.commerceCourse.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!taken) return code;
  }
}
