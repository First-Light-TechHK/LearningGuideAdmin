import { exhibitCardPositions } from './text-structure';

/**
 * 展品还被用着时，删除要告诉用户用在哪里（PRD：展品被引用时不能删，并说明位置）。
 * 位置的写法：`Video 2.1` = 第 2 课，视频触发表（按时间排序）的第 1 行；
 * `Text 2.3` = 第 2 课，正文里第 3 个学习点（H1）之下；在第一个 H1 之前写 `Text 2`。
 * 这里都是纯函数，库里的读取由调用方做。
 */

export interface ExhibitUsage {
  kind: 'VIDEO' | 'TEXT';
  language: string;
  /** 课时位置，后面跟行号或学习点序号：`2.1`、`2.3`；只有课时位置时就是 `2`。 */
  position: string;
}

export interface UsageTrigger {
  exhibitId: string | null;
  language: string;
  timeSeconds: number | null;
  sortOrder: number;
}

/** 触发表的显示顺序：先按时间，没填时间的排最后，同一时间按保存顺序。 */
function byTimeThenSaved(a: UsageTrigger, b: UsageTrigger): number {
  if (a.timeSeconds !== b.timeSeconds) {
    if (a.timeSeconds === null) return 1;
    if (b.timeSeconds === null) return -1;
    return a.timeSeconds - b.timeSeconds;
  }
  return a.sortOrder - b.sortOrder;
}

/** 这个展品在本课时各语言的视频触发表里用在第几行（行号从 1 起，每种语言各数各的）。 */
export function videoUsages(
  lessonPosition: number,
  triggers: readonly UsageTrigger[],
  exhibitId: string,
): ExhibitUsage[] {
  const languages = [...new Set(triggers.map((row) => row.language))].sort();
  const usages: ExhibitUsage[] = [];
  for (const language of languages) {
    const rows = triggers
      .filter((row) => row.language === language)
      .sort(byTimeThenSaved);
    for (const [index, row] of rows.entries()) {
      if (row.exhibitId === exhibitId) {
        usages.push({
          kind: 'VIDEO',
          language,
          position: `${lessonPosition}.${index + 1}`,
        });
      }
    }
  }
  return usages;
}

/** 这个展品在本课时各语言的正文里用在第几个学习点之下；同一处出现几张卡片只算一处。 */
export function textUsages(
  lessonPosition: number,
  texts: ReadonlyArray<{ language: string; textHtml: string | null }>,
  exhibit: { id: string; code: string },
): ExhibitUsage[] {
  const usages: ExhibitUsage[] = [];
  for (const text of [...texts].sort((a, b) =>
    a.language.localeCompare(b.language),
  )) {
    const places = [
      ...new Set(exhibitCardPositions(text.textHtml, exhibit)),
    ].sort((a, b) => a - b);
    for (const place of places) {
      usages.push({
        kind: 'TEXT',
        language: text.language,
        position:
          place === 0 ? `${lessonPosition}` : `${lessonPosition}.${place}`,
      });
    }
  }
  return usages;
}

const MOST_SHOWN = 5;

/**
 * `Used in Video 2.1, Text 2.3. Remove it there first.`：视频的位置在前；
 * 位置落在不止一种语言里时每处后面加 `(语言)`；超过五处只列前五处。
 */
export function exhibitInUseMessage(usages: readonly ExhibitUsage[]): string {
  const several = new Set(usages.map((usage) => usage.language)).size > 1;
  const labels: string[] = [];
  for (const kind of ['VIDEO', 'TEXT'] as const) {
    for (const usage of usages) {
      if (usage.kind !== kind) continue;
      const label = `${kind === 'VIDEO' ? 'Video' : 'Text'} ${usage.position}${
        several ? ` (${usage.language})` : ''
      }`;
      if (!labels.includes(label)) labels.push(label);
    }
  }
  const shown = labels.slice(0, MOST_SHOWN);
  const more = labels.length - shown.length;
  return `Used in ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Remove it there first.`;
}
