import type { HistoryPage } from '../../contracts/course'

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
  if (!detail) return item.versionNo ? `v${item.versionNo}` : '—'
  const text = (value: unknown) =>
    value === null || value === undefined || value === '' ? '—' : String(value)
  switch (item.action) {
    case 'PUBLISH':
      return [
        text(detail.versionLabel),
        detail.sourceEnvironment
          ? `${zh ? '来源' : 'from'} ${text(detail.sourceEnvironment)} ${text(detail.sourceVersionLabel)}`
          : null,
        detail.notifyLearners ? (zh ? '已通知学员' : 'learners notified') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'DELETE_DRAFT':
      return zh ? `保留 ${text(detail.keptVersion)}` : `Kept ${text(detail.keptVersion)}`
    case 'RESTORE':
      return zh
        ? `从 ${text(detail.restoredFrom)} 恢复`
        : `Restored from ${text(detail.restoredFrom)}`
    case 'CHANGE_STATUS':
      return `${text(detail.from)} → ${text(detail.to)}${detail.reason ? ` · ${text(detail.reason)}` : ''}`
    case 'EXPORT_PACKAGE':
      return `${zh ? '版本' : 'Version'} ${text(detail.versionLabel)}`
    case 'IMPORT_PACKAGE':
      return (
        [
          detail.versionLabel ? `${zh ? '版本' : 'Version'} ${text(detail.versionLabel)}` : null,
          detail.sourceVersionLabel
            ? `${zh ? '来源' : 'from'} ${text(detail.sourceVersionLabel)}`
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
