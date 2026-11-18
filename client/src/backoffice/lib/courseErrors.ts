import type { ApiFailure } from './api';
import type { Locale } from './i18n/config';
import { t } from './i18n/messages';

/**
 * 课程页面共用的错误文案（服务器是唯一的判断方）。
 *
 * 服务器的错误是 { code, message, details }：code 稳定，message 是英文句子，details 带行号、名字、展品位置等。
 * 页面按 code 取本地化文案，用 details 填空。认不出的 code 用 failure.message：
 * 请求层已经把它转成页面语言（英文界面是服务器的英文句子，中文界面是译文或通用提示）。
 */

export type CourseFailure = Pick<ApiFailure, 'error' | 'message' | 'code' | 'details' | 'status'>;

const asLocale = (locale: string): Locale => (locale.startsWith('zh') ? 'zh-CN' : 'en-GB');

export function failureCode(failure: CourseFailure): string {
  return failure.code ?? failure.error;
}

/** details.row 是 1 起的行号；不是正整数就当没有。 */
export function failureRow(failure: CourseFailure): number | null {
  const row = failure.details?.row;
  return typeof row === 'number' && Number.isInteger(row) && row >= 1 ? row : null;
}

function languageName(locale: Locale, language: string): string {
  if (language === 'zh-CN') return t(locale, 'course.ui.languageChinese');
  if (language === 'en-GB' || language === 'en') return t(locale, 'course.ui.languageEnglish');
  return language;
}

type Usage = { kind?: string; language?: string; position?: string };

/** 展品还在用：`Video 2.1, Text 2.3`，位置落在不止一种语言里时每处后面加（语言），最多列五处。 */
export function exhibitUsagePlaces(locale: string, usages: unknown): string {
  const l = asLocale(locale);
  const list = (Array.isArray(usages) ? usages : []) as Usage[];
  const several = new Set(list.map((usage) => usage.language)).size > 1;
  const labels: string[] = [];
  for (const kind of ['VIDEO', 'TEXT']) {
    for (const usage of list) {
      if (usage.kind !== kind) continue;
      const name = t(l, kind === 'VIDEO' ? 'course.ui.usageVideo' : 'course.ui.usageText');
      const suffix = several && usage.language ? ` (${languageName(l, usage.language)})` : '';
      const label = `${name} ${usage.position ?? ''}${suffix}`.trim();
      if (!labels.includes(label)) labels.push(label);
    }
  }
  const shown = labels.slice(0, 5);
  const more = labels.length - shown.length;
  return more > 0 ? `${shown.join(', ')} ${t(l, 'course.ui.usageMore', { count: more })}` : shown.join(', ');
}

const MESSAGE_FIRST = new Set(['REQUIRED', 'TRIAL_CUTOFF_INVALID', 'PLAN_LOOKUP_KEY_DUPLICATE', 'VERSION_INCOMPLETE']);

/** 一条失败的原因，按页面语言写成一句话。 */
export function courseErrorText(locale: string, failure: CourseFailure): string {
  const l = asLocale(locale);
  const code = failureCode(failure);
  const details = failure.details ?? {};
  const row = failureRow(failure);
  const key = `course.errors.${code}`;
  const known = t(l, key) !== key;
  if (!known) {
    // 没有服务器错误码、只有一句话（如导出任务自己的失败原因）：直接用这句话，不套通用提示。
    if (!failure.code && failure.message?.trim()) return failure.message.trim();
    // 登录类错误码有自己的文案（NOT_AUTHORISED、RATE_LIMITED……）。
    const generic = t(l, `errors.${failure.error}`);
    if (generic !== `errors.${failure.error}`) return generic;
    // 其余：请求层已经把服务器句子转成页面语言（英文界面是服务器的英文句子，中文界面是译文或通用提示），直接用。
    return failure.message?.trim() || t(l, 'errors.serverGeneric');
  }
  // 这几种的服务器句子带具体的位置或名字（"Question 1 is required."），英文界面直接用；中文界面用本地句子。
  if (l === 'en-GB' && MESSAGE_FIRST.has(code) && failure.message?.trim()) return failure.message.trim();
  switch (code) {
    case 'COURSE_STALE': {
      const name = typeof details.updatedByName === 'string' && details.updatedByName.trim() ? details.updatedByName.trim() : null;
      return name ? t(l, 'course.errors.COURSE_STALE', { name }) : t(l, 'course.errors.COURSE_STALE_UNKNOWN');
    }
    case 'LESSON_ORDER_INCOMPLETE':
      return t(l, key, { expected: String(details.expected ?? '?'), received: String(details.received ?? '?') });
    case 'EXHIBIT_IN_USE':
      return t(l, key, { places: exhibitUsagePlaces(locale, details.usages) });
    case 'READING_COLUMNS_INVALID': {
      const missing = Array.isArray(details.missing) ? details.missing.filter((item): item is string => typeof item === 'string') : [];
      return t(l, key, { missing: missing.join(', ') });
    }
    case 'VALIDATION_ERROR':
      return t(l, key, { field: typeof details.field === 'string' ? details.field : '' });
    case 'INVALID_TIME':
    case 'DUPLICATE_TRIGGER':
    case 'EXHIBIT_NOT_IN_LESSON':
    case 'READING_TYPE_INVALID':
      return row === null ? t(l, `${key}_NO_ROW`) : t(l, key, { row });
    default:
      return t(l, key);
  }
}

/** `操作名称: 原因`，页面上"保存失败: …"这类提示的统一写法。 */
export function courseFailureNotice(locale: string, action: string, failure: CourseFailure): string {
  return `${action}: ${courseErrorText(locale, failure)}`;
}

/** 这些错误说明页面上的数据已经不是服务器上的了：页面要提示重新载入。 */
export function failureNeedsReload(failure: CourseFailure): boolean {
  return ['LESSON_NOT_FOUND', 'EXHIBIT_NOT_FOUND', 'COURSE_NOT_FOUND'].includes(failureCode(failure));
}

export function isStale(failure: CourseFailure): boolean {
  return failureCode(failure) === 'COURSE_STALE';
}

/** 行级错误：只有带行号的那几种错误会挂到某一行上。 */
export function rowFailure(locale: string, failure: CourseFailure): { row: number; code: string; text: string } | null {
  const row = failureRow(failure);
  if (row === null) return null;
  return { row, code: failureCode(failure), text: courseErrorText(locale, failure) };
}
