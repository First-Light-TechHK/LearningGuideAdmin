import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/** Figma 写法「27 Oct 2026」；中文界面用「2026年10月27日」。 */
export function formatStudentDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

/** 按错误码给员工看的文案；未知码统一兜底。 */
export function studentErrorText(locale: Locale, code: string): string {
  const key = `studentError.${code}`
  const text = t(locale, key)
  return text === key ? t(locale, 'studentError.default') : text
}

export function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? Array.from(trimmed)[0]!.toUpperCase() : '?'
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
