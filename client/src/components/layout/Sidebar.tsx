import { useEffect, useState } from 'react'
import { Panel, Select, Typography } from '../ui'
import { SearchBox } from '../knowledge/SearchBox'
import { CourseTree } from '../knowledge/CourseTree'
import { SyncButtons } from '../knowledge/SyncButtons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { tokens } from '../../theme/tokens'
import { useKText } from '../knowledge/i18n'

/**
 * 左侧边栏（§3.1/§3.2.2）：课程选择器 + 目录树 + 搜索框 + 底部 Sync 按钮。
 * 同步目标选中即切换（2026-10-15 改：锁定/解锁机制移除），树只显示目标对应本地课程；
 * 未选目标时树默认展示全部课件（BUG-0227，2026-10-27），清空选择即回到全部视图；
 * 本地课程由同步产生，不提供手动新建课程入口（用户拍板：新建课程彻底移除）。
 * 2026-10-16 去掉下拉项的同步状态 Tag（已同步/未同步/有更新）。
 * 2026-10-26 同步数据源改为 KS 内置课程 ID 映射表，下拉项即映射表课程 + 本地独有课程。
 */
export function Sidebar() {
  const externalCourses = useKnowledgeStore((s) => s.externalCourses)
  const externalCoursesError = useKnowledgeStore((s) => s.externalCoursesError)
  const selectedExternalId = useKnowledgeStore((s) => s.selectedExternalId)
  const loadExternalCourses = useKnowledgeStore((s) => s.loadExternalCourses)
  const selectExternal = useKnowledgeStore((s) => s.selectExternal)

  const [keyword, setKeyword] = useState('')
  const { text } = useKText()

  // 首次进入拉取外部源列表
  useEffect(() => {
    void loadExternalCourses()
  }, [loadExternalCourses])

  return (
    // 侧栏卡片化（2026-10-19）：根节点改为白色圆角面板（padding 默认 16），与右侧内容面板统一；
    // 外层灰底与内边距由 MainLayout 的 Sider 提供
    <Panel style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: tokens.spacing.sm }}>
        <Typography.Text type="secondary" style={{ fontSize: tokens.fontSize.md }}>
          {text('sidebar.syncTarget')}
        </Typography.Text>
        <Select
          style={{ width: '100%', marginTop: tokens.spacing.xs }}
          placeholder={text('sidebar.allCoursesPlaceholder')}
          value={selectedExternalId ?? undefined}
          onSelect={(v: string) => void selectExternal(v)}
          // 清空目标回到全部课件视图（BUG-0227）
          allowClear
          onClear={() => void selectExternal(null)}
          options={externalCourses.map((e) => ({
            value: e.externalId,
            label: e.title,
          }))}
        />
        {externalCoursesError && (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: tokens.spacing.xs, fontSize: tokens.fontSize.md }}>
            {externalCoursesError}
          </Typography.Text>
        )}
      </div>
      <SearchBox value={keyword} onChange={setKeyword} />
      {/* 2026-10-22：只允许纵向滚动；长 lesson/heading 名称用省略号，不出现横向滚动条 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', marginTop: tokens.spacing.sm }}>
        <CourseTree keyword={keyword} />
      </div>
      <div style={{ marginTop: tokens.spacing.sm }}>
        <SyncButtons />
      </div>
    </Panel>
  )
}
