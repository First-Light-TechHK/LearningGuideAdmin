import { Prisma } from '@prisma/client';
import {
  allocate,
  formatLearningPointCode,
  learningPointCounterKey,
} from './code-allocator';
import type { CourseTx } from './course-write';
import {
  matchTextPoints,
  parseTextStructure,
  stampLearningPoints,
} from './text-structure';

/**
 * 文本学习点就地保存（PRD 12.5.2：正文里的每个 H1 是一个学习点）。
 *
 * 在调用方已锁住课程的事务里做：
 * - 每个 H1 先按它身上的 `data-lp` 章认出已有的行，没有章再按标题顺序认（matchTextPoints），
 *   认出的行改标题、改位置，id 和编号不变；
 * - 认不出的 H1 是新的，编号由计数器分配（页面自己编的编号不算数，删掉的编号不会再发），
 *   标题重复、标题为空都照样保存（空标题由完整性规则报告）；
 * - 正文里已经没有的行删除；
 * - 把编号盖回每个 H1，存下盖过章的正文，同步课时上的 `textLearningPoints` 镜像，
 *   并把盖过章的正文返回给调用方（编辑器此后持有的就是这份）。
 *
 * `html` 为 null（清空正文）时删掉所有文本学习点，返回 null。
 */
export async function syncTextPointsInTx(
  tx: CourseTx,
  lessonId: string,
  language: string,
  html: string | null,
): Promise<string | null> {
  const headings = parseTextStructure(html);
  const sameLanguage = await tx.learningPoint.findMany({
    where: { lessonId, language },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      code: true,
      title: true,
      source: true,
      anchorHeading: true,
      sortOrder: true,
    },
  });
  const existing = sameLanguage.filter((lp) => lp.source === 'TEXT');
  const takenCodes = new Set(sameLanguage.map((lp) => lp.code));

  const matches = matchTextPoints(headings, existing);
  const kept = new Set<string>();
  for (const row of matches) if (row) kept.add(row.id);

  const stale = existing.filter((lp) => !kept.has(lp.id)).map((lp) => lp.id);
  if (stale.length > 0) {
    await tx.learningPoint.deleteMany({ where: { id: { in: stale } } });
  }

  const codes: string[] = [];
  for (const [index, heading] of headings.entries()) {
    const found = matches[index];
    if (found) {
      codes.push(found.code);
      if (
        found.title !== heading.title ||
        found.anchorHeading !== heading.title ||
        found.sortOrder !== index
      ) {
        await tx.learningPoint.update({
          where: { id: found.id },
          data: {
            title: heading.title,
            anchorHeading: heading.title,
            sortOrder: index,
          },
        });
      }
      continue;
    }
    let code: string;
    do {
      code = formatLearningPointCode(
        'TEXT',
        await allocate(tx, learningPointCounterKey(lessonId, language, 'TEXT')),
      );
    } while (takenCodes.has(code));
    takenCodes.add(code);
    await tx.learningPoint.create({
      data: {
        lessonId,
        language,
        source: 'TEXT',
        code,
        title: heading.title,
        anchorHeading: heading.title,
        sortOrder: index,
      },
    });
    codes.push(code);
  }

  const stamped = html === null ? null : stampLearningPoints(html, codes);
  const mirror = headings.map((heading, index) => ({
    code: codes[index],
    heading: heading.title,
    level: 1,
  }));
  await tx.lessonLocalization.update({
    where: { lessonId_language: { lessonId, language } },
    data: {
      ...(stamped !== html ? { textHtml: stamped } : {}),
      textLearningPoints:
        mirror.length > 0
          ? (mirror as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
  });
  return stamped;
}
