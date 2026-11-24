import type { HistoryPage } from '../../contracts/course'
import { languageLabel, learningModeLabel } from './shared-utils'
import { versionName } from './versionNumbering'

export function historyActionLabel(action: string, locale: string): string {
  const zh = locale.startsWith('zh')
  switch (action) {
    case 'PUBLISH':
      return zh ? '发布' : 'Publish'
    case 'DELETE_DRAFT':
      return zh ? '删除草稿' : 'Delete draft'
    case 'RESTORE':
      return zh ? '恢复版本' : 'Restore'
    case 'EXPORT_PACKAGE':
      return zh ? '导出课程包' : 'Export package'
    case 'IMPORT_PACKAGE':
      return zh ? '导入课程包' : 'Import package'
    case 'CHANGE_STATUS':
      return zh ? '更改状态' : 'Change status'
    case 'OPERATIONS_PUBLISH':
      return zh ? '发布运营位' : 'Publish operations'
    case 'CREATE_COURSE':
      return zh ? '新建课程' : 'Create course'
    default:
      return action
  }
}

export function historyDetailText(item: HistoryPage['items'][number], locale: string): string {
  const zh = locale.startsWith('zh')
  const detail =
    item.detail && typeof item.detail === 'object' ? (item.detail as Record<string, unknown>) : null
  if (!detail) return '—'
  const text = (value: unknown) =>
    value === null || value === undefined || value === '' ? '—' : String(value)
  // One version number everywhere: "Version 4.2" / "版本 4.2", never the internal sequence.
  const vn = (value: unknown) =>
    value === null || value === undefined || value === '' ? '—' : versionName(locale, String(value))
  switch (item.action) {
    case 'PUBLISH':
      return [
        vn(detail.versionLabel),
        detail.sourceEnvironment
          ? `${zh ? '来源' : 'from'} ${text(detail.sourceEnvironment)} ${vn(detail.sourceVersionLabel)}`
          : null,
        detail.notifyLearners ? (zh ? '已通知用户' : 'learners notified') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'DELETE_DRAFT':
      return zh ? `保留 ${vn(detail.keptVersion)}` : `Kept ${vn(detail.keptVersion)}`
    case 'RESTORE':
      return zh
        ? `从 ${vn(detail.restoredFrom)} 恢复`
        : `Restored from ${vn(detail.restoredFrom)}`
    case 'CHANGE_STATUS':
      return `${text(detail.from)} → ${text(detail.to)}${detail.reason ? ` · ${text(detail.reason)}` : ''}`
    case 'EXPORT_PACKAGE':
      return vn(detail.versionLabel)
    case 'CREATE_COURSE':
      return (
        [
          detail.courseCode ? text(detail.courseCode) : null,
          detail.learningMode ? learningModeLabel(locale, String(detail.learningMode)) : null,
          Array.isArray(detail.learningLanguages) && detail.learningLanguages.length > 0
            ? detail.learningLanguages.map((code) => languageLabel(locale, String(code))).join(' / ')
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'
      )
    case 'IMPORT_PACKAGE':
      return (
        [
          detail.fileName ? text(detail.fileName) : null,
          detail.versionLabel ? vn(detail.versionLabel) : null,
          detail.sourceVersionLabel
            ? `${zh ? '来源' : 'from'} ${vn(detail.sourceVersionLabel)}`
            : null,
          detail.lessonCount !== undefined
            ? `${text(detail.lessonCount)} ${zh ? '课时' : 'lessons'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'
      )
    case 'OPERATIONS_PUBLISH':
      return (
        [
          detail.section ? `${zh ? '区域' : 'Section'} ${text(detail.section)}` : null,
          detail.reason ? `${zh ? '原因' : 'Reason'}: ${text(detail.reason)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'
      )
    default:
      return (
        Object.entries(detail)
          .map(([key, value]) => `${key}: ${text(value)}`)
          .join(' · ') || '—'
      )
  }
}
