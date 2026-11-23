import type { CourseDetail, CourseLocalization } from '../../../contracts/course';
import { keepIfDirty } from './merge';

export const PRESETS = [
  { key: 'VIDEO_TEXT', en: 'Video & text dual-mode learning', zh: '视频与文本双模式学习' },
  { key: 'EXHIBITS', en: 'Multiple reference exhibits', zh: '多个参考展品' },
  { key: 'AI_ASSISTANT', en: 'AI-powered learning assistant', zh: 'AI 学习助手' },
  { key: 'AI_GUIDED', en: 'AI-guided deep comprehension', zh: 'AI 引导深度理解' },
  { key: 'READINGS', en: 'Extended readings for context', zh: '延伸阅读' },
  { key: 'BILINGUAL', en: 'Bilingual: Chinese / English', zh: '中英双语' },
];

export type LearnRowDraft = { en: string; zh: string };
export type ProvidesRowDraft = { type: string; key?: string; en: string; zh: string };

/** 课程信息步的全部本地草稿，与页面上的输入一一对应。 */
export type InfoDraft = {
  categoryId: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  overviewEn: string;
  overviewZh: string;
  learnRows: LearnRowDraft[];
  providesRows: ProvidesRowDraft[];
};

function loc(course: CourseDetail, language: string): CourseLocalization | undefined {
  return course.localizations.find((item) => item.language === language);
}

/** 条目列表：空条目也要留着，两种语言的条目靠位置对应，丢掉空的会让下面的行错位。 */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) =>
        typeof item === 'string'
          ? item
          : ((item as { title?: string; text?: string } | null)?.title ??
            (item as { text?: string } | null)?.text ??
            ''),
      )
    : [];
}

function providerList(value: unknown): Array<{ type: string; title: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { type: 'custom', title: item };
    const record = item as { type?: string; title?: string; text?: string };
    return { type: record.type ?? 'custom', title: record.title ?? record.text ?? '' };
  });
}

export function presetKeyFor(title: string): string | undefined {
  const normalized = title.trim().toLowerCase();
  return PRESETS.find((preset) => preset.en.toLowerCase() === normalized || preset.zh.toLowerCase() === normalized)?.key;
}

/** 服务器快照 → 课程信息草稿。 */
export function infoDraftOf(course: CourseDetail): InfoDraft {
  const enLoc = loc(course, 'en-GB') ?? loc(course, 'en');
  const zhLoc = loc(course, 'zh-CN') ?? loc(course, 'zh');
  const enLearn = stringList(enLoc?.whatYouLearn);
  const zhLearn = stringList(zhLoc?.whatYouLearn);
  const enProvides = providerList(enLoc?.provides);
  const zhProvides = providerList(zhLoc?.provides);
  return {
    categoryId: course.categoryId ?? '',
    titleEn: enLoc?.title ?? '',
    titleZh: zhLoc?.title ?? '',
    descEn: enLoc?.shortDescription ?? '',
    descZh: zhLoc?.shortDescription ?? '',
    overviewEn: enLoc?.overview ?? '',
    overviewZh: zhLoc?.overview ?? '',
    learnRows: Array.from({ length: Math.max(enLearn.length, zhLearn.length) }, (_, index) => ({
      en: enLearn[index] ?? '',
      zh: zhLearn[index] ?? '',
    })),
    providesRows: Array.from({ length: Math.max(enProvides.length, zhProvides.length) }, (_, index) => {
      const enItem = enProvides[index];
      const zhItem = zhProvides[index];
      // 只有两种语言都是同一个预设的原文时才算预设（预设两边只读）；一边空着或改过就是自定义，两边都能改。
      const enKey = enItem ? presetKeyFor(enItem.title) : undefined;
      const key = enKey && enKey === (zhItem ? presetKeyFor(zhItem.title) : undefined) ? enKey : undefined;
      return {
        type: key ? 'preset' : 'custom',
        key,
        en: enItem?.title ?? '',
        zh: zhItem?.title ?? '',
      };
    }),
  };
}

/** 重载后的合并：按行数组整体比较（与 6a833b2 对数组的处理一致）。 */
export function mergeInfoDraft(current: InfoDraft, snapshot: InfoDraft, server: InfoDraft): InfoDraft {
  return {
    categoryId: keepIfDirty(current.categoryId, snapshot.categoryId, server.categoryId),
    titleEn: keepIfDirty(current.titleEn, snapshot.titleEn, server.titleEn),
    titleZh: keepIfDirty(current.titleZh, snapshot.titleZh, server.titleZh),
    descEn: keepIfDirty(current.descEn, snapshot.descEn, server.descEn),
    descZh: keepIfDirty(current.descZh, snapshot.descZh, server.descZh),
    overviewEn: keepIfDirty(current.overviewEn, snapshot.overviewEn, server.overviewEn),
    overviewZh: keepIfDirty(current.overviewZh, snapshot.overviewZh, server.overviewZh),
    learnRows: keepIfDirty(current.learnRows, snapshot.learnRows, server.learnRows),
    providesRows: keepIfDirty(current.providesRows, snapshot.providesRows, server.providesRows),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseLearnRows(raw: unknown): LearnRowDraft[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: LearnRowDraft[] = [];
  for (const row of raw) {
    if (!isRecord(row) || !isString(row.en) || !isString(row.zh)) return null;
    rows.push({ en: row.en, zh: row.zh });
  }
  return rows;
}

function parseProvidesRows(raw: unknown): ProvidesRowDraft[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ProvidesRowDraft[] = [];
  for (const row of raw) {
    if (!isRecord(row) || !isString(row.type) || !isString(row.en) || !isString(row.zh)) return null;
    if (row.key !== undefined && !isString(row.key)) return null;
    rows.push({ type: row.type, key: row.key as string | undefined, en: row.en, zh: row.zh });
  }
  return rows;
}

/** 存储里的课程信息草稿：外部输入在边界解析一次；形状不符 → 整条按损坏处理。 */
export function parseInfoDraft(raw: unknown): InfoDraft | null {
  if (!isRecord(raw)) return null;
  const strings = ['categoryId', 'titleEn', 'titleZh', 'descEn', 'descZh', 'overviewEn', 'overviewZh'] as const;
  if (!strings.every((key) => isString(raw[key]))) return null;
  const learnRows = parseLearnRows(raw.learnRows);
  const providesRows = parseProvidesRows(raw.providesRows);
  if (!learnRows || !providesRows) return null;
  return {
    categoryId: raw.categoryId as string,
    titleEn: raw.titleEn as string,
    titleZh: raw.titleZh as string,
    descEn: raw.descEn as string,
    descZh: raw.descZh as string,
    overviewEn: raw.overviewEn as string,
    overviewZh: raw.overviewZh as string,
    learnRows,
    providesRows,
  };
}
