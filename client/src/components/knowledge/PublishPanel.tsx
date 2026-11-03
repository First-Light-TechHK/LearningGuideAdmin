import { useCallback, useEffect, useState } from 'react'
import { App, Button, Input, Modal, Panel, Table, Tag, Typography } from '../ui'
import type { ColumnsType } from '../ui'
import { knowledgeApi, type ReleaseSummary } from '../../api/knowledge'
import { DownloadOutlined } from '@ant-design/icons'
import { CloseIcon } from '../icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'

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
  const { text } = useKText()
  /** PRD §3.2/§3.3：发布/切换版本是 PUBLISH、删除版本是 DELETE；View/Edit 不显示 */
  const access = useWorkspaceAccess()
  const courses = useKnowledgeStore((s) => s.courses)
  const afterActivateRelease = useKnowledgeStore((s) => s.afterActivateRelease)
  const [latest, setLatest] = useState<Record<string, ReleaseSummary[]>>({})
  const [historyCourse, setHistoryCourse] = useState<string | null>(null)
  const [publishCourse, setPublishCourse] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

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
    // 发布中再次触发（回车、连点）直接忽略，服务端另有重复提交保护
    if (!publishCourse || !notes.trim() || publishing) return
    setPublishing(true)
    try {
      await knowledgeApi.publish(publishCourse, notes.trim())
      message.success(text('publish.success'))
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
      title: text('publish.activateTitle', { version: release.versionTag }),
      content: text('publish.activateContent'),
      okText: text('publish.activateConfirm'),
      okButtonProps: { danger: true },
      cancelText: text('common.cancel'),
      onOk: async () => {
        try {
          await knowledgeApi.activateRelease(courseId, release.id)
          message.success(text('publish.activated', { version: release.versionTag }))
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
      title: text('publish.deleteTitle', { version: release.versionTag }),
      content: text('publish.deleteContent'),
      okText: text('tree.delete'),
      okButtonProps: { danger: true },
      cancelText: text('common.cancel'),
      onOk: async () => {
        try {
          await knowledgeApi.deleteRelease(release.id)
          message.success(text('publish.deleted', { version: release.versionTag }))
          await loadReleases()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  /**
   * 下载版本快照为 ZIP（方案 B，2026-10-30 新增）。
   * VIEW 权限即可；纯读，不改变任何状态。
   */
  const doDownload = async (release: ReleaseSummary) => {
    if (downloadingId) return
    setDownloadingId(release.id)
    try {
      const { blob, filename } = await knowledgeApi.exportRelease(release.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      message.success(text('publish.downloaded', { version: release.versionTag }))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setDownloadingId(null)
    }
  }

  const columns: ColumnsType<(typeof courses)[number]> = [
    { title: text('publish.colCourse'), dataIndex: 'title' },
    {
      title: text('publish.colNotes'),
      key: 'notes',
      render: (_, record) => {
        // 最新发布的快照备注（列表按 createdAt 倒序，取首条；2026-10-20 由「激活版本备注」改）
        const note = latest[record.id]?.[0]?.revisionNotes
        return note || (
          <Typography.Text type="secondary">{text('publish.noNotes')}</Typography.Text>
        )
      },
    },
    {
      title: text('publish.colLatest'),
      key: 'version',
      render: (_, record) => {
        const current = latest[record.id]?.[0]
        if (!current) {
          return <Typography.Text type="secondary">{text('publish.unpublished')}</Typography.Text>
        }
        return (
          <a onClick={() => setHistoryCourse(record.id)}>{current.versionTag}</a>
        )
      },
    },
    {
      title: text('publish.colAction'),
      key: 'action',
      render: (_, record) =>
        access.canPublish ? (
          <Button type="primary" size="small" onClick={() => setPublishCourse(record.id)}>
            {text('publish.createRelease')}
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
        {text('publish.title')}
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
        title={text('publish.historyTitle')}
        footer={null}
        onCancel={() => setHistoryCourse(null)}
        width={640}
      >
        {historyList.length === 0 ? (
          <Typography.Text type="secondary">{text('publish.noHistory')}</Typography.Text>
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
                  {/* 下载按钮（图标，VIEW 权限即可；2026-10-30 新增） */}
                  <Button
                    type="text"
                    size="small"
                    icon={<DownloadOutlined />}
                    style={{ marginLeft: tokens.spacing.sm }}
                    aria-label={text('publish.downloadVersionAria', { version: r.versionTag })}
                    loading={downloadingId === r.id}
                    onClick={() => doDownload(r)}
                  />
                  {/* editing 紧贴版本名右侧（2026-10-20 三次改拍）；定序 editing → live → testing */}
                  {r.isEditing && <Tag color="green">{text('publish.tagEditing')}</Tag>}
                  {r.isActive && <Tag color="green">{text('publish.tagLive')}</Tag>}
                  {r.isTestSelected && <Tag>{text('publish.tagTesting')}</Tag>}
                  <Typography.Text type="secondary">
                    {new Date(r.createdAt).toLocaleString()}
                  </Typography.Text>
                  {/* editing 版本不可再「切换到此版本」（2026-10-20 三次改拍） */}
                  {access.canPublish && historyCourse && !r.isEditing && (
                    <Button
                      size="small"
                      style={{ marginLeft: tokens.spacing.sm }}
                      onClick={() => doActivate(historyCourse, r)}
                    >
                      {text('publish.switchTo')}
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
                    aria-label={text('publish.deleteVersionAria', { version: r.versionTag })}
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
        title={text('publish.publishModalTitle', {
          title: courses.find((c) => c.id === publishCourse)?.title ?? '',
        })}
        okText={text('publish.publish')}
        cancelText={text('common.cancel')}
        confirmLoading={publishing}
        okButtonProps={{ disabled: !notes.trim() }}
        onOk={doPublish}
        onCancel={() => {
          setPublishCourse(null)
          setNotes('')
        }}
      >
        <Typography.Paragraph type="secondary">
          {text('publish.publishHint')}
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder={text('publish.notesPlaceholder')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
        />
      </Modal>
    </Panel>
  )
}
