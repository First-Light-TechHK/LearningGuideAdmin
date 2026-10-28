import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/** 有译文用译文，没有就原样显示（Portal 新增的分类 / 事件不会让页面出现 key）。 */
function labelOr(locale: Locale, key: string, raw: string): string {
  const value = t(locale, key)
  return value === key ? raw : value
}

export function statusLabel(locale: Locale, status: string): string {
  return labelOr(locale, `helpDesk.status.${status}`, status)
}

export function categoryLabel(locale: Locale, category: string): string {
  return labelOr(locale, `helpDesk.category.${category}`, category)
}

export function eventLabel(locale: Locale, type: string): string {
  return labelOr(locale, `helpDesk.events.${type}`, type)
}

export function closeReasonLabel(locale: Locale, reason: string): string {
  return labelOr(locale, `helpDesk.closeReason.${reason}`, reason)
}

export function errorMessage(locale: Locale, code: string): string {
  const key = `helpDesk.errors.${code}`
  const value = t(locale, key)
  return value === key ? t(locale, 'helpDesk.errors.generic') : value
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** 相对时间（「3 小时前」「in 2 days」）；无法解析时返回空串。 */
export function relativeTime(iso: string | null, locale: Locale, now = Date.now()): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const seconds = Math.round((time - now) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'minute')
}

export function absoluteTime(iso: string | null, locale: Locale): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function localeName(locale: Locale, value: string): string {
  if (value === 'zh-CN') return locale === 'zh-CN' ? '简体中文' : 'Chinese (Simplified)'
  if (value === 'en-GB') return locale === 'zh-CN' ? '英语（英国）' : 'English (UK)'
  return value || '—'
}
