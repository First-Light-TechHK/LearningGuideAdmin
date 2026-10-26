import { useCallback, useEffect, useState } from 'react'
import { App, Button, Input, Modal, Panel, Table, Tag, Typography } from '../ui'
import type { ColumnsType } from '../ui'
import { knowledgeApi, type ReleaseSummary } from '../../api/knowledge'
import { CloseIcon } from '../icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

/**
 * Releases 版本发布面板（§3.4；2026-10-15 激活版本模型；2026-10-19 由 Publish 更名为 Releases）：
 * - 列表上方标题行：Knowledge Releases
 * - 表格列：Course Name / Revision Notes / Latest Release（最新发布快照，可点击）/ Action
 * - 点击版本号 → Modal 展示历史版本：标题固定「历史版本」（2026-10-20 三次改拍，移除课程名与 editing）；
 *   每个版本行状态标签定序：版本号 → editing（紧贴版本名右侧）→ live → testing；
 *   「切换到此版本」（所有版本，含 Live）仅恢复快照到可编辑草稿，**不改 Live 指针**
 *   （Live 只由 AI Tutor 的 Set Live 变更，2026-10-20 二次改拍）；**editing 版本不显示该按钮**（三次改拍）；
 *   非保护版本删除 ×（§3.4.5 双保护：Live / 后台测试所选无删除入口）
 * - Create Release → Modal 必填 Revision Notes → POST /api/courses/:id/release（纯快照，2026-10-20 改拍：
 *   不再激活/改写 Live 指针，但会置 `editingReleaseId` = 新版本，§3.4.3）→ 刷新
 */
export function PublishPanel() {
  const { message, modal } = App.useApp()
  /** PRD §3.2/§3.3：发布/切换版本是 PUBLISH、删除版本是 DELETE；View/Edit 不显示 */
  const access = useWorkspaceAccess()
  const courses = useKnowledgeStore((s) => s.courses)
  const afterActivateRelease = useKnowledgeStore((s) => s.afterActivateRelease)
  const [latest, setLatest] = useState<Record<string, ReleaseSummary[]>>({})
  const [historyCourse, setHistoryCourse] = useState<string | null>(null)
  const [publishCourse, setPublishCourse] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [publishing, setPublishing] = useState(false)

  const loadReleases = useCallback(async () => {
    const map: Record<string, ReleaseSummary[]> = {}
    await Promise.all(
      courses.map(async (c) => {
        map[c.id] = await knowledgeApi.listReleases(c.id)
      }),
    )
    setLatest(map)
  }, [courses])

  useEffect(() => {
    void loadReleases()
  }, [loadReleases])

  const doPublish = async () => {
    if (!publishCourse || !notes.trim()) return
    setPublishing(true)
    try {
      await knowledgeApi.publish(publishCourse, notes.trim())
      message.success('发布成功')
      setPublishCourse(null)
      setNotes('')
      await loadReleases()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const doActivate = (courseId: string, release: ReleaseSummary) => {
    modal.confirm({
      title: `切换到此版本 ${release.versionTag}？`,
      content:
        '将以该版本内容覆盖当前可编辑草稿（含未发布的修改）。此操作不可撤销。',
      okText: '确认切换',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await knowledgeApi.activateRelease(courseId, release.id)
          message.success(`已切换到版本 ${release.versionTag}`)
          setHistoryCourse(null)
          await loadReleases()
          await afterActivateRelease(courseId)
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  /** 删除版本（§3.4.5，2026-10-20 新增）：Live / 后台测试所选版本无删除入口 */
  const doDelete = (release: ReleaseSummary) => {
    modal.confirm({
      title: `删除版本 ${release.versionTag}？`,
      content: '将永久删除该版本快照及其 AI 配置，不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await knowledgeApi.deleteRelease(release.id)
          message.success(`已删除版本 ${release.versionTag}`)
          await loadReleases()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  const columns: ColumnsType<(typeof courses)[number]> = [
    { title: 'Course Name', dataIndex: 'title' },
    {
      title: 'Revision Notes',
      key: 'notes',
      render: (_, record) => {
        // 最新发布的快照备注（列表按 createdAt 倒序，取首条；2026-10-20 由「激活版本备注」改）
        const note = latest[record.id]?.[0]?.revisionNotes
        return note || (
          <Typography.Text type="secondary">No revision notes provided</Typography.Text>
        )
      },
    },
    {
      title: 'Latest Release',
      key: 'version',
      render: (_, record) => {
        const current = latest[record.id]?.[0]
        if (!current) {
          return <Typography.Text type="secondary">未发布</Typography.Text>
        }
        return (
          <a onClick={() => setHistoryCourse(record.id)}>{current.versionTag}</a>
        )
      },
    },
    {
      title: 'Action',
      key: 'action',
      render: (_, record) =>
        access.canPublish ? (
          <Button type="primary" size="small" onClick={() => setPublishCourse(record.id)}>
            Create Release
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ]

  const historyList = historyCourse ? latest[historyCourse] ?? [] : []

  return (
    // 内容面板（2026-10-19 对齐 Figma）：白色/圆角12/无边框/卡片阴影，与 Knowledge Pages、AI Tutor 统一
    <Panel style={{ overflow: 'auto' }}>
      {/* 列表上方标题行（2026-10-19 新增） */}
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: tokens.spacing.md }}>
        Knowledge Releases
      </Typography.Title>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={courses}
        pagination={false}
        size="middle"
      />

      {/* 历史版本列表（§3.4.2：标题固定「历史版本」；每版本行 editing（紧贴版本名）/ live / testing + 删除 + 切换到此版本） */}
      <Modal
        open={!!historyCourse}
        title="历史版本"
        footer={null}
        onCancel={() => setHistoryCourse(null)}
        width={640}
      >
        {historyList.length === 0 ? (
          <Typography.Text type="secondary">暂无发布记录</Typography.Text>
        ) : (
          historyList.map((r) => {
            const protectedVersion = r.isActive || r.isTestSelected
            return (
              <div
                key={r.id}
                style={{ marginBottom: tokens.spacing.md, display: 'flex', alignItems: 'flex-start' }}
              >
                <div style={{ flex: 1 }}>
                  <Tag color={r.isActive ? 'green' : 'geekblue'}>{r.versionTag}</Tag>
                  {/* editing 紧贴版本名右侧（2026-10-20 三次改拍）；定序 editing → live → testing */}
                  {r.isEditing && <Tag color="green">editing</Tag>}
                  {r.isActive && <Tag color="green">live</Tag>}
                  {r.isTestSelected && <Tag>testing</Tag>}
                  <Typography.Text type="secondary">
                    {new Date(r.createdAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                  {/* editing 版本不可再「切换到此版本」（2026-10-20 三次改拍） */}
                  {access.canPublish && historyCourse && !r.isEditing && (
                    <Button
                      size="small"
                      style={{ marginLeft: tokens.spacing.sm }}
                      onClick={() => doActivate(historyCourse, r)}
                    >
                      切换到此版本
                    </Button>
                  )}
                  <div>
                    <Typography.Text>{r.revisionNotes}</Typography.Text>
                  </div>
                </div>
                {/* Live / 后台测试所选版本受保护，不显示删除 ×（2026-10-20 双保护） */}
                {access.canDelete && !protectedVersion && (
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label={`删除版本 ${r.versionTag}`}
                    onClick={() => doDelete(r)}
                  >
                    <CloseIcon size={16} />
                  </Button>
                )}
              </div>
            )
          })
        )}
      </Modal>

      {/* 发布 Modal（§3.4.3：Revision Notes 必填） */}
      <Modal
        open={!!publishCourse}
        title={`发布课程「${courses.find((c) => c.id === publishCourse)?.title ?? ''}」全部页面快照`}
        okText="发布"
        cancelText="取消"
        confirmLoading={publishing}
        okButtonProps={{ disabled: !notes.trim() }}
        onOk={doPublish}
        onCancel={() => {
          setPublishCourse(null)
          setNotes('')
        }}
      >
        <Typography.Paragraph type="secondary">
          Create Release 将发布整个课程下所有页面的快照（非单个页面）。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="Revision Notes（必填）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
        />
      </Modal>
    </Panel>
  )
}
