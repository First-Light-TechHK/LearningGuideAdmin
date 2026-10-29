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
