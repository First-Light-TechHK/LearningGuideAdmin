import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/** 有译文用译文，没有就原样显示（Portal 新增的状态 / 分类不会让页面出现 key）。 */
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

export function billingCycleLabel(locale: Locale, cycle: string): string {
  return labelOr(locale, `helpDesk.billingCycle.${cycle.trim().toLowerCase()}`, cycle)
}

export function subscriptionStatusLabel(locale: Locale, status: string): string {
  return labelOr(locale, `helpDesk.subscriptionStatus.${status.trim().toLowerCase()}`, status)
}

export function contentLocaleLabel(locale: Locale, value: string): string {
  return labelOr(locale, `helpDesk.localeName.${value}`, value)
}

export function errorMessage(locale: Locale, code: string): string {
  const key = `helpDesk.errors.${code}`
  const value = t(locale, key)
  return value === key ? t(locale, 'helpDesk.errors.generic') : value
}

/** FAQ 分类（account_technical / courses_learning / payments_subscriptions / other）。 */
export function faqCategoryLabel(locale: Locale, category: string): string {
  return labelOr(locale, `helpDesk.faqCategory.${category}`, category)
}

/* ------------------------------ v4 Part A：订单 ------------------------------ */

export function orderStatusLabel(locale: Locale, status: string): string {
  return labelOr(locale, `helpDesk.orderStatus.${status.trim().toLowerCase()}`, status)
}

export function paymentModeLabel(locale: Locale, mode: string): string {
  return labelOr(locale, `helpDesk.paymentMode.${mode.trim().toLowerCase()}`, mode)
}

/**
 * 订单金额：Portal 给的是最小货币单位的整数（3900 = 39.00）。按币种的小数位换算（JPY 等无小数的不除），
 * 缺金额或币种时显示 —。
 */
export function formatOrderAmount(locale: Locale, amount: number | null | undefined, currency: string | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !currency) return '—'
  const code = currency.toUpperCase()
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2
    return format.format(amount / 10 ** digits)
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`
  }
}
