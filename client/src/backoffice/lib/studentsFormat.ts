import type { StudentActionEmail } from '../contracts/students'
import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/**
 * Portal 把兴趣存成固定的英文标签（顺序见 Portal messages 的 interestLabels）。
 * 标签放在语言包里（studentDrawer.interestLabel），中文界面显示中文；未知值原样返回，
 * 避免 Portal 新增标签时界面出现空白。
 */
export function formatStudentInterest(locale: Locale, value: string): string {
  return studentOptionLabel(locale, 'interestLabel', value)
}

/** Portal 把学历存成固定英文选项（Secondary education … Other）；规则同兴趣。 */
export function formatStudentEducation(locale: Locale, value: string): string {
  return studentOptionLabel(locale, 'educationLabel', value)
}

/**
 * Portal 把国家存成选项列表里的英文名称（如 United Kingdom）；列表可由运营修改。
 * 若存的是两位 ISO 代码，用平台的 Intl.DisplayNames；否则查语言包；都不认识就原样显示。
 */
export function formatStudentCountry(locale: Locale, value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed) && trimmed.toUpperCase() !== 'ZZ') {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }).of(trimmed.toUpperCase())
      if (name) return name
    } catch {
      // 非法区域代码：按原值显示
    }
    return value
  }
  return studentOptionLabel(locale, 'countryLabel', value)
}

function studentOptionLabel(locale: Locale, group: string, value: string): string {
  const key = `studentDrawer.${group}.${value.trim()}`
  const label = t(locale, key)
  return label === key ? value : label
}

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

/**
 * 动作返回的邮件状态。新 Portal 契约用 { sent:null, pending:true } 表示“已受理、正在发送”；
 * 旧服务端只给 sent 布尔值，语义保持不变（sent:false = 已保存但邮件没发出去）。
 */
export type EmailDelivery = 'sent' | 'unsent' | 'pending'

export function emailDelivery(email: StudentActionEmail | null): EmailDelivery | null {
  if (!email) return null
  if (email.pending === true) return 'pending'
  return email.sent === false ? 'unsent' : 'sent'
}
