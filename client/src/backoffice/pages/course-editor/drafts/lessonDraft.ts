import type { Lesson } from '../../../contracts/course';
import type { PointDraft, ReadingDraft, TriggerDraft } from '../../../lib/courseRequests';
import { fmtTimeInput } from '../shared-utils';
import { keepIfDirty } from './merge';

/** 课时编辑器的全部本地草稿，与页面上的输入一一对应。 */
export type LessonDraft = {
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  videoLps: PointDraft[];
  triggerRows: TriggerDraft[];
  readingRows: ReadingDraft[];
  textHtml: string;
};

export function emptyLessonDraft(): LessonDraft {
  return { titleEn: '', titleZh: '', descEn: '', descZh: '', videoLps: [], triggerRows: [], readingRows: [], textHtml: '' };
}

function loc(lesson: Lesson | undefined, language: string) {
  if (!lesson || !Array.isArray(lesson.localizations)) return undefined;
  return lesson.localizations.find((item) => item.language === language) ?? lesson.localizations[0];
}

/** 服务器快照 → 当前内容语言下的完整草稿。 */
export function lessonDraftOf(lesson: Lesson | undefined, language: string): LessonDraft {
  if (!lesson) return emptyLessonDraft();
  const en = loc(lesson, 'en-GB');
  const zh = loc(lesson, 'zh-CN');
  const currentLoc = loc(lesson, language);
  return {
    titleEn: en?.title ?? '',
    titleZh: zh?.title ?? '',
    descEn: en?.description ?? '',
    descZh: zh?.description ?? '',
    videoLps: lesson.learningPoints
      .filter((point) => point.language === language && point.source === 'VIDEO')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((point) => ({ id: point.id, code: point.code, title: point.title, timeText: fmtTimeInput(point.timeSeconds) })),
    triggerRows: (lesson.triggers ?? [])
      .filter((trigger) => trigger.language === language)
      .map((trigger) => ({ exhibitId: trigger.exhibitId ?? '', timeText: fmtTimeInput(trigger.timeSeconds) })),
    readingRows: lesson.readings.map((reading) => ({
      id: reading.id,
      type: reading.type,
      title: reading.title ?? '',
      author: reading.author ?? '',
      whyRecommended: reading.whyRecommended ?? '',
    })),
    textHtml: currentLoc?.textHtml ?? '',
  };
}

/**
 * 重载后的草稿合并：用户改过（与上次服务器快照不同）的字段保留，没改过的跟随服务器。
 * GET 详情每次都是新对象；不合并就会把未保存的输入（正文、课时标题/简介等）静默重置成服务器值。
 */
export function mergeLessonDraft(current: LessonDraft, snapshot: LessonDraft, server: LessonDraft): LessonDraft {
  return {
    titleEn: keepIfDirty(current.titleEn, snapshot.titleEn, server.titleEn),
    titleZh: keepIfDirty(current.titleZh, snapshot.titleZh, server.titleZh),
    descEn: keepIfDirty(current.descEn, snapshot.descEn, server.descEn),
    descZh: keepIfDirty(current.descZh, snapshot.descZh, server.descZh),
    videoLps: keepIfDirty(current.videoLps, snapshot.videoLps, server.videoLps),
    triggerRows: keepIfDirty(current.triggerRows, snapshot.triggerRows, server.triggerRows),
    readingRows: keepIfDirty(current.readingRows, snapshot.readingRows, server.readingRows),
    textHtml: keepIfDirty(current.textHtml, snapshot.textHtml, server.textHtml),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalStrings(row: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => row[key] === undefined || isString(row[key]));
}

/** 存储里的课时草稿：外部输入在边界解析一次；任何字段形状不符 → 整条按损坏处理。 */
export function parseLessonDraft(raw: unknown): LessonDraft | null {
  if (!isRecord(raw)) return null;
  const strings = ['titleEn', 'titleZh', 'descEn', 'descZh', 'textHtml'] as const;
  if (!strings.every((key) => isString(raw[key]))) return null;
  if (!Array.isArray(raw.videoLps) || !Array.isArray(raw.triggerRows) || !Array.isArray(raw.readingRows)) return null;
  const videoLps: PointDraft[] = [];
  for (const row of raw.videoLps) {
    if (!isRecord(row) || !isString(row.title) || !isString(row.timeText) || !optionalStrings(row, ['id', 'code'])) return null;
    videoLps.push({ id: row.id as string | undefined, code: row.code as string | undefined, title: row.title, timeText: row.timeText });
  }
  const triggerRows: TriggerDraft[] = [];
  for (const row of raw.triggerRows) {
    if (!isRecord(row) || !isString(row.exhibitId) || !isString(row.timeText)) return null;
    triggerRows.push({ exhibitId: row.exhibitId, timeText: row.timeText });
  }
  const readingRows: ReadingDraft[] = [];
  for (const row of raw.readingRows) {
    if (
      !isRecord(row) ||
      !isString(row.type) ||
      !isString(row.title) ||
      !isString(row.author) ||
      !isString(row.whyRecommended) ||
      !optionalStrings(row, ['id'])
    ) {
      return null;
    }
    readingRows.push({
      id: row.id as string | undefined,
      type: row.type,
      title: row.title,
      author: row.author,
      whyRecommended: row.whyRecommended,
    });
  }
  return {
    titleEn: raw.titleEn as string,
    titleZh: raw.titleZh as string,
    descEn: raw.descEn as string,
    descZh: raw.descZh as string,
    videoLps,
    triggerRows,
    readingRows,
    textHtml: raw.textHtml as string,
  };
}

/** 推荐阅读只有一份列表：保存时服务器会删掉请求里没有的行，列出全部行才不误删。 */
export function readingsOf(lesson: Lesson): Lesson['readings'] {
  return lesson.readings;
}
