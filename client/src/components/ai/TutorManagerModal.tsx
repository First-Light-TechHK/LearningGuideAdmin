import { useMemo, useState } from 'react'
import { App, Input, Modal, Switch, Table } from '../ui'
import type { ColumnsType } from '../ui'
import { useAiStore } from '../../stores/aiStore'
import type { AiTutorListView } from '../../api/ai'
import { tokens } from '../../theme/tokens'
import { useAiText } from './i18n'

/**
 * 「管理所有 online」弹窗（§4.2.6，2026-10-20）：
 * 由 Change Course 下拉面板底部链接打开；表格罗列全部 AI Tutor 及其 Online 状态，
 * 支持按名称 / Online 状态列头排序、右上角搜索按名称过滤；每行开关点即改即存；
 * 改动当前选中课程时同步顶部卡片开关（由 store 保证）。
 */
export function TutorManagerModal() {
  const { message } = App.useApp()
  const open = useAiStore((s) => s.tutorManagerOpen)
  const close = useAiStore((s) => s.closeTutorManager)
  const tutors = useAiStore((s) => s.tutors)
  const loading = useAiStore((s) => s.tutorsLoading)
  const setTutorOnline = useAiStore((s) => s.setTutorOnline)
  const { text } = useAiText()

  const [keyword, setKeyword] = useState('')

  // 2026-10-28 复盘 A1：开关只改 online，但学员端入口还要求"已同步 Portal"与
  // "有上线版本"。这两个前提不满足时开关点了也不生效，因此这里显示原因并禁用开关。
  const STATUS_TEXT: Record<
    NonNullable<AiTutorListView['blockedReason']> | 'available',
    { text: string; colour: string }
  > = {
    available: { text: text('learnerAvailable'), colour: '#0f9960' },
    'not-synced': { text: text('learnerNotSynced'), colour: '#c2410c' },
    'no-live-release': { text: text('learnerNoLiveRelease'), colour: '#c2410c' },
    'not-online': { text: text('learnerNotOnline'), colour: '#64748b' },
  }

  // 搜索：按名称过滤（不区分大小写）
  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    return k ? tutors.filter((t) => t.title.toLowerCase().includes(k)) : tutors
  }, [tutors, keyword])

  const columns: ColumnsType<AiTutorListView> = [
    {
      title: text('managerColumnTutor'),
      dataIndex: 'title',
      key: 'title',
      sorter: (a, b) => a.title.localeCompare(b.title),
    },
    {
      title: text('managerColumnLearner'),
      dataIndex: 'available',
      key: 'available',
      width: 150,
      sorter: (a, b) => Number(a.available) - Number(b.available),
      render: (_: boolean, row) => {
        const status = STATUS_TEXT[row.available ? 'available' : row.blockedReason ?? 'not-online']
        return (
          <span style={{ color: status.colour, fontSize: 12 }} title={status.text}>
            {status.text}
          </span>
        )
      },
    },
    {
      title: text('managerColumnOnline'),
      dataIndex: 'online',
      key: 'online',
      width: 120,
      sorter: (a, b) => Number(a.online) - Number(b.online),
      render: (_: boolean, row) => (
        <Switch
          size="small"
          checked={row.online}
          // 已同步且有上线版本时开关才有意义；否则点了学员端也不会出现入口。
          disabled={!row.externalId || !row.hasLiveRelease}
          onChange={async (v) => {
            try {
              await setTutorOnline(row.courseId, v)
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        />
      ),
    },
  ]

  return (
    <Modal
      title={text('managerTitle')}
      open={open}
      onCancel={close}
      footer={null}
      width={560}
      destroyOnHidden
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: tokens.spacing.sm,
        }}
      >
        <Input.Search
          allowClear
          placeholder={text('managerSearch')}
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      <Table
        rowKey="courseId"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        pagination={false}
        size="small"
      />
    </Modal>
  )
}
