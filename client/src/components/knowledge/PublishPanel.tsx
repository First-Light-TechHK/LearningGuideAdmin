import { useCallback, useEffect, useState } from 'react'
import { App, Button, Input, Modal, Panel, Select, Spin, Table, Tag, Typography } from '../ui'
import type { ColumnsType } from '../ui'
import { knowledgeApi, type ReleaseDetail, type ReleaseSummary } from '../../api/knowledge'
import { KnowledgeMarkdown } from './KnowledgeMarkdown'
import { ReleasePackageUpload } from './ReleasePackageUpload'
import { DownloadOutlined } from '@ant-design/icons'
import { CloseIcon } from '../icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccessState';
import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'
import { formatDateTime } from '../../backoffice/lib/i18n/format'

const indexTags = {
  building: { key: 'publish.indexBuilding', color: 'processing' },
  ready: { key: 'publish.indexReady', color: 'success' },
  missing: { key: 'publish.indexMissing', color: 'warning' },
  failed: { key: 'publish.indexFailed', color: 'error' },
} as const

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
  const { locale, text } = useKText()
  /** PRD §3.2/§3.3：发布/切换版本是 PUBLISH、删除版本是 DELETE；View/Edit 不显示 */
  const access = useWorkspaceAccess()
  const courses = useKnowledgeStore((s) => s.courses)
  const afterActivateRelease = useKnowledgeStore((s) => s.afterActivateRelease)
  const [latest, setLatest] = useState<Record<string, ReleaseSummary[]>>({})
  const [historyCourse, setHistoryCourse] = useState<string | null>(null)
  const [publishCourse, setPublishCourse] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [teachingPackage, setTeachingPackage] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [rebuildingId, setRebuildingId] = useState<string | null>(null)

  const [previewId, setPreviewId] = useState('')
  const [snapshot, setSnapshot] = useState<ReleaseDetail | null>(null)
  const [pageId, setPageId] = useState('')
  const previewPage = snapshot?.snapshotData.pages.find(page => page.id === pageId)
  useEffect(() => {
    if (!previewId) return
    let active = true
    knowledgeApi.getRelease(previewId).then(detail => {
      if (!active) return
      setSnapshot(detail)
      setPageId(detail.snapshotData.pages[0]?.id ?? '')
    }).catch((error: Error) => {
      if (active) { message.error(error.message); setPreviewId('') }
    })
    return () => { active = false }
  }, [previewId, message])

  const loadReleases = useCallback(() => {
    const map: Record<string, ReleaseSummary[]> = {}
    return Promise.all(
      courses.map(async (c) => {
        map[c.id] = await knowledgeApi.listReleases(c.id)
      }),
    ).then(() => setLatest(map))
  }, [courses])

  useEffect(() => {
    void loadReleases()
  }, [loadReleases])

  const buildingCourseIds = Object.entries(latest)
    .filter(([, releases]) => releases.some((release) => release.indexStatus === 'building'))
    .map(([id]) => id)
    .join(',')

  useEffect(() => {
    if (!buildingCourseIds) return
    let disposed = false
    const courseIds = buildingCourseIds.split(',')
    let pending = false
    const timer = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        const lists = await Promise.allSettled(courseIds.map((id) => knowledgeApi.listReleases(id)))
        if (!disposed) setLatest((current) => {
          const next = { ...current }
          lists.forEach((list, index) => {
            if (list.status === 'fulfilled') next[courseIds[index]] = list.value
          })
          return next
        })
      } finally {
        pending = false
      }
    }, 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [buildingCourseIds])

  const indexTag = (release: ReleaseSummary) => {
    if (!release.indexStatus) return null
    const tag = indexTags[release.indexStatus]
    return <Tag color={tag.color}>{text(tag.key, { count: release.indexChunkCount ?? 0 })}</Tag>
  }

  const doRebuildIndex = async (courseId: string, releaseId: string) => {
    setRebuildingId(releaseId)
    try {
      await knowledgeApi.rebuildReleaseIndex(releaseId)
      setLatest((current) => ({
        ...current,
        [courseId]: (current[courseId] ?? []).map((release) => (
          release.id === releaseId ? { ...release, indexStatus: 'building' } : release
        )),
      }))
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setRebuildingId(null)
    }
  }

  const doPublish = async () => {
    // 发布中再次触发（回车、连点）直接忽略，服务端另有重复提交保护
    if (!publishCourse || !notes.trim() || publishing) return
    setPublishing(true)
    try {
      let reviewed: Record<string, unknown> | undefined
      if (teachingPackage.trim()) {
        let value: unknown
        try {
          value = JSON.parse(teachingPackage)
        } catch {
          throw new Error(text('publish.teachingPackageInvalid'))
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error(text('publish.teachingPackageInvalid'))
        reviewed = value as Record<string, unknown>
      }
      if (reviewed) await knowledgeApi.publish(publishCourse, notes.trim(), reviewed)
      else await knowledgeApi.publish(publishCourse, notes.trim())
      message.success(text('publish.success'))
      setPublishCourse(null)
      setNotes('')
      setTeachingPackage('')
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
      content: text(release.hasEditorSnapshot ? 'publish.activateContent' : 'publish.legacyActivateContent'),
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
  const doDownload = async (release: ReleaseSummary, migration = false) => {
    if (downloadingId) return
    setDownloadingId(release.id)
    try {
      const { blob, filename } = migration ? await knowledgeApi.exportRelease(release.id, 'package') : await knowledgeApi.exportRelease(release.id)
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
          if (access.canPublish) return <Button type="link" size="small" onClick={() => setHistoryCourse(record.id)}>{text('publish.historyTitle')}</Button>
          return <Typography.Text type="secondary">{text('publish.unpublished')}</Typography.Text>
        }
        return (
          <>
            <a style={{ marginRight: tokens.spacing.sm }} onClick={() => setHistoryCourse(record.id)}>{current.versionTag}</a>
            {indexTag(current)}
          </>
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
        centered
        width="min(960px, calc(100vw - 32px))"
        style={{ margin: 0 }}
        styles={{
          content: {
            boxSizing: 'border-box',
            height: 'min(82dvh, calc(100dvh - 32px))',
            display: 'flex',
            flexDirection: 'column',
          },
          body: { flex: 1, minHeight: 0, overflowY: 'auto' },
        }}
      >
        {historyCourse && access.canPublish && <ReleasePackageUpload key={historyCourse} courseId={historyCourse} onImported={loadReleases} />}
        {historyList.length === 0 ? (
          <Typography.Text type="secondary">{text('publish.noHistory')}</Typography.Text>
        ) : (
          historyList.map((r) => {
            const protectedVersion = r.isActive || r.isTestSelected
            return (
              <div
                key={r.id}
                style={{
                  marginBottom: tokens.spacing.md,
                  padding: tokens.spacing.md,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'flex',
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <Tag color={r.isActive ? 'green' : 'geekblue'} style={{ whiteSpace: 'normal' }}>
                    {r.versionTag}
                  </Tag>
                  {/* 下载按钮（图标，VIEW 权限即可；2026-10-30 新增） */}
                  <Button
                    type="text"
                    size="small"
                    icon={<DownloadOutlined />}
                    style={{ marginLeft: tokens.spacing.sm }}
                    aria-label={text('publish.downloadVersionAria', { version: r.versionTag })}
                    title={text('publish.downloadVersionAria', { version: r.versionTag })}
                    loading={downloadingId === r.id}
                    onClick={() => doDownload(r)}
                  />
                  {r.hasEditorSnapshot && <Button type="text" size="small" disabled={!!downloadingId}
                    onClick={() => void doDownload(r, true)}>{text('publish.downloadPackage')}</Button>}
                  {r.hasEditorSnapshot === false && <Typography.Text type="secondary">{text('publish.legacyPackage')}</Typography.Text>}
                  {/* editing 紧贴版本名右侧（2026-10-20 三次改拍）；定序 editing → live → testing */}
                  <Button type="text" size="small" onClick={() => { setSnapshot(null); setPreviewId(r.id) }}>
                    {text('editor.preview')}
                  </Button>
                  {r.isEditing && <Tag color="green">{text('publish.tagEditing')}</Tag>}
                  {r.isActive && <Tag color="green">{text('publish.tagLive')}</Tag>}
                  {r.isTestSelected && <Tag>{text('publish.tagTesting')}</Tag>}
                  <Typography.Text type="secondary">
                    {formatDateTime(locale, r.createdAt)}
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
                  <div>
                    {indexTag(r)}
                    {access.canPublish && historyCourse && r.indexStatus && r.indexStatus !== 'building' && (
                      <Button
                        size="small"
                        disabled={rebuildingId !== null}
                        loading={rebuildingId === r.id}
                        onClick={() => void doRebuildIndex(historyCourse, r.id)}
                      >
                        {text('publish.rebuildIndex')}
                      </Button>
                    )}
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

      <Modal open={!!previewId} title={snapshot?.versionTag ?? text('editor.preview')} width={800} footer={null}
        onCancel={() => setPreviewId('')}>
        {!snapshot ? <Spin /> : <>
          <Select aria-label={text('teaching.sourcePage')} value={pageId || undefined} onChange={setPageId}
            options={snapshot.snapshotData.pages.map(page => ({ value: page.id, label: page.title }))} />
          {previewPage && <div data-color-mode="light"><KnowledgeMarkdown source={previewPage.contentMd}
            courseId={snapshot.courseId}
            references={snapshot.snapshotData.teachingPackage?.cards.flatMap(card => card.approvedPayload?.refObjects ?? []) ?? []} /></div>}
        </>}
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
          setTeachingPackage('')
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
        <Input.TextArea
          rows={5}
          style={{ marginTop: tokens.spacing.md }}
          aria-label={text('publish.teachingPackageLabel')}
          placeholder={text('publish.teachingPackagePlaceholder')}
          value={teachingPackage}
          onChange={(event) => setTeachingPackage(event.target.value)}
          maxLength={500_000}
        />
      </Modal>
    </Panel>
  )
}
