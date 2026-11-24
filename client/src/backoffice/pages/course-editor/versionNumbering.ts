import type { CourseVersion } from '../../contracts/course'
import type { Locale } from '../../lib/i18n/config'
import { t } from '../../lib/i18n/messages'

export type NumberingMode = 'sandbox' | 'production'
type Last = { versionSeries: number; versionMinor: number; exportedAt?: string | null } | null

/** 与服务端 publishing.service.ts 的 nextVersionLabel 同一条规则：下一次发布会得到的版本号（只用于提示，服务端才分配号）。 */
export function nextVersionLabel(mode: NumberingMode, last: Last): string {
  if (mode === 'production') return `Version ${(last?.versionMinor ?? 0) + 1}`
  if (!last) return '1.1'
  if (last.exportedAt) return `${last.versionSeries + 1}.1`
  return `${last.versionSeries}.${last.versionMinor + 1}`
}

/** 最新版本（versionNo 最大），不一定是线上版本。 */
export function latestVersion(versions: CourseVersion[]): CourseVersion | null {
  let best: CourseVersion | null = null
  for (const version of versions) if (!best || version.versionNo > best.versionNo) best = version
  return best
}

/** “4.2” 或 “Version 4” → “Version 4.2” / “版本 4.2”。 */
export function versionName(locale: string, label: string): string {
  const n = label.replace(/^Version\s+/i, '').trim()
  return t((locale.startsWith('zh') ? 'zh-CN' : 'en-GB') as Locale, 'course.ui.versions.name', { n })
}
