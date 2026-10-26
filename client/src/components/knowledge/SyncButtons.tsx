import { App, Button, Space } from '../ui'
import { SyncOutlined } from '@ant-design/icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import type { SyncSummary } from '../../api/knowledge'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

/**
 * Sync 同步按钮（§3.2.2）：
 * 2026-10-26 起同步数据源为 KS 内置课程 ID 映射表（不再向 Portal 拉取），
 * 只同步「课程标题 + 课时标题」，不读写正文；同步目标为侧栏顶部下拉当前选中课程。
 * PRD §3.2/§3.3：同步属于 CREATE 级写操作，View/Edit 角色不显示。
 */
export function SyncButtons() {
  const access = useWorkspaceAccess()
  if (!access.canCreate) return null
  return <SyncButtonsInner />
}

function SyncButtonsInner() {
  const { message } = App.useApp()
  const selectedExternalId = useKnowledgeStore((s) => s.selectedExternalId)
  const syncing = useKnowledgeStore((s) => s.syncing)
  const runSync = useKnowledgeStore((s) => s.runSync)

  const doSync = async () => {
    try {
      const summary: SyncSummary = await runSync('structure')
      if (summary.unchanged) {
        message.info('课程与课时标题已与课程映射表一致，无变更')
      } else {
        const parts: string[] = []
        if (summary.courseCreated > 0) parts.push(`新增 ${summary.courseCreated} 门课程`)
        if (summary.created > 0) parts.push(`新增 ${summary.created} 个课时`)
        if (summary.updated > 0) parts.push(`更新 ${summary.updated} 个标题`)
        message.success(`同步完成：${parts.join('，')}`)
      }
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const disabled = !selectedExternalId

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={tokens.spacing.xs}>
      <Button
        block
        type="primary"
        icon={<SyncOutlined spin={syncing} />}
        loading={syncing}
        disabled={disabled}
        onClick={() => void doSync()}
      >
        同步课程标题
      </Button>
      {disabled && (
        <span style={{ fontSize: tokens.fontSize.md, color: tokens.color.text.tertiary }}>
          请先在上方选择同步目标
        </span>
      )}
    </Space>
  )
}
