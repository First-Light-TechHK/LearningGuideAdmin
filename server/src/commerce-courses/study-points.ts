import { BadRequestException } from '@nestjs/common';
import {
  allocate,
  formatLearningPointCode,
  learningPointCounterKey,
} from './code-allocator';
import type { CourseTx } from './course-write';
import { optionalNonNegativeInt, requireArray } from './input';

/**
 * Study 里的视频学习点和展品触发：保存时存下用户填的，没填完的由完整性规则报告。
 * 只拒绝形状不对的输入（时间不是非负整数、展品不属于本课时、完全重复的触发）。
 *
 * 校验（parse*）是纯函数；写库（save*InTx）在调用方已锁住课程的事务里做，
 * 一键保存 Study（B15）也复用这两个函数。
 */

function refuse(
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new BadRequestException({ code, message, details });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 时间点：空（null、''、没传）是还没填；其余必须是非负整数，否则 400 INVALID_TIME 并指出第几行。 */
function timeOf(value: unknown, row: number, field: string): number | null {
  return optionalNonNegativeInt(value, field, {
    code: 'INVALID_TIME',
    details: { row },
  });
}

/** 文字：没传和 null 得到 ''（标题没填也照存）；不是文字就 400。 */
function textOf(value: unknown, row: number, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    return refuse('VALIDATION_ERROR', `${field} must be text.`, { field, row });
  }
  return value;
}

/** 编号或 id：空得到 undefined；不是文字就 400。 */
function keyOf(value: unknown, row: number, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    return refuse('VALIDATION_ERROR', `${field} must be text.`, { field, row });
  }
  return value.trim() || undefined;
}

export interface VideoPointRow {
  id?: string;
  code?: string;
  title: string;
  timeSeconds: number | null;
}

export function parseVideoPoints(input: unknown): VideoPointRow[] {
  const rows = requireArray(input, 'points', { emptyIfMissing: true });
  return rows.map((raw, index) => {
    const row = index + 1;
    const path = `points[${index}]`;
    if (!isObject(raw)) {
      return refuse('VALIDATION_ERROR', `${path} must be an object.`, {
        field: path,
        row,
      });
    }
    return {
      id: keyOf(raw.id, row, `${path}.id`),
      code: keyOf(raw.code, row, `${path}.code`),
      title: textOf(raw.title, row, `${path}.title`),
      timeSeconds: timeOf(raw.timeSeconds, row, `${path}.timeSeconds`),
    };
  });
}

export interface SavedVideoPoint {
  id: string;
  code: string;
  title: string;
  timeSeconds: number | null;
  sortOrder: number;
}

/**
 * 视频学习点就地保存：先按 id、再按 code 认出已有的行（改标题、改时间、换位置都不换 id 和编号），
 * 认不出的是新行，编号由计数器分配（页面自己编的编号不算数，删掉的编号不会再发），
 * 请求里没有的已有行删除。`sortOrder` 跟请求顺序。
 */
export async function saveVideoPointsInTx(
  tx: CourseTx,
  lessonId: string,
  language: string,
  rows: VideoPointRow[],
): Promise<SavedVideoPoint[]> {
  const sameLanguage = await tx.learningPoint.findMany({
    where: { lessonId, language },
    select: { id: true, code: true, source: true },
  });
  const existing = sameLanguage.filter((lp) => lp.source === 'VIDEO');
  const byId = new Map(existing.map((lp) => [lp.id, lp]));
  const byCode = new Map(existing.map((lp) => [lp.code, lp]));
  const takenCodes = new Set(sameLanguage.map((lp) => lp.code));

  const matched = new Set<string>();
  const plan = rows.map((row, index) => {
    let found = row.id ? byId.get(row.id) : undefined;
    if (!found && row.code) found = byCode.get(row.code);
    if (found && matched.has(found.id)) found = undefined;
    if (found) matched.add(found.id);
    return { row, index, found };
  });

  const stale = existing.filter((lp) => !matched.has(lp.id)).map((lp) => lp.id);
  if (stale.length > 0) {
    await tx.learningPoint.deleteMany({ where: { id: { in: stale } } });
  }

  const saved: SavedVideoPoint[] = [];
  for (const { row, index, found } of plan) {
    const data = {
      title: row.title,
      timeSeconds: row.timeSeconds,
      sortOrder: index,
    };
    if (found) {
      await tx.learningPoint.update({ where: { id: found.id }, data });
      saved.push({ id: found.id, code: found.code, ...data });
      continue;
    }
    let code: string;
    do {
      code = formatLearningPointCode(
        'VIDEO',
        await allocate(
          tx,
          learningPointCounterKey(lessonId, language, 'VIDEO'),
        ),
      );
    } while (takenCodes.has(code));
    takenCodes.add(code);
    const created = await tx.learningPoint.create({
      data: { lessonId, language, source: 'VIDEO', code, ...data },
      select: { id: true },
    });
    saved.push({ id: created.id, code, ...data });
  }
  return saved;
}

export interface TriggerRow {
  exhibitId: string | null;
  timeSeconds: number | null;
}

export function parseTriggers(input: unknown): TriggerRow[] {
  const rows = requireArray(input, 'triggers', { emptyIfMissing: true });
  return rows.map((raw, index) => {
    const row = index + 1;
    const path = `triggers[${index}]`;
    if (!isObject(raw)) {
      return refuse('VALIDATION_ERROR', `${path} must be an object.`, {
        field: path,
        row,
      });
    }
    return {
      exhibitId: keyOf(raw.exhibitId, row, `${path}.exhibitId`) ?? null,
      timeSeconds: timeOf(raw.timeSeconds, row, `${path}.timeSeconds`),
    };
  });
}

/**
 * 展品触发整批保存：展品可以还没选、时间可以还没填；同一个展品可以在几个时间点出现，
 * 但同一个展品同一个时间点只能有一行。`sortOrder` 跟请求顺序，读出来时先按时间再按它排。
 */
export async function saveTriggersInTx(
  tx: CourseTx,
  lessonId: string,
  language: string,
  rows: TriggerRow[],
  lessonExhibitIds: ReadonlySet<string>,
): Promise<{ triggers: number }> {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.exhibitId && !lessonExhibitIds.has(row.exhibitId)) {
      refuse(
        'EXHIBIT_NOT_IN_LESSON',
        `Exhibit of trigger ${index + 1} does not belong to this lesson.`,
        { row: index + 1 },
      );
    }
    if (row.exhibitId && row.timeSeconds !== null) {
      const key = `${row.exhibitId}@${row.timeSeconds}`;
      if (seen.has(key)) {
        refuse(
          'DUPLICATE_TRIGGER',
          `Trigger ${index + 1} repeats the same exhibit at the same time.`,
          { row: index + 1 },
        );
      }
      seen.add(key);
    }
  }
  await tx.exhibitTrigger.deleteMany({ where: { lessonId, language } });
  for (const [index, row] of rows.entries()) {
    await tx.exhibitTrigger.create({
      data: {
        lessonId,
        language,
        exhibitId: row.exhibitId,
        timeSeconds: row.timeSeconds,
        sortOrder: index,
      },
    });
  }
  return { triggers: rows.length };
}
