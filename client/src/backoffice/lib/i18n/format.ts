import type { Locale } from "./config";

/**
 * 日期时间一律按页面语言格式化。不传语言的 toLocaleString() 用的是浏览器语言，
 * 中文浏览器看英文页面时会出现中文日期（反之亦然）；i18n 守卫测试禁止直接调用。
 */
export function formatDateTime(locale: Locale | string, value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
