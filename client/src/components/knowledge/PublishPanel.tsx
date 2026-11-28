import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Input, Modal, Panel, Select, Spin, Table, Tag, Typography } from '../ui'
import type { ColumnsType } from '../ui'
import { knowledgeApi, type ReleaseDetail, type ReleaseSummary } from '../../api/knowledge'
import { KnowledgeMarkdown } from './KnowledgeMarkdown'
import { ReleasePackageUpload } from './ReleasePackageUpload'
import { ReleaseDownloadModal } from './ReleaseDownloadModal'
import { TeachingTransferSection } from './TeachingTransferStep'
import { DownloadOutlined } from '@ant-design/icons'
import { CloseIcon } from '../icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccessState';
import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'
import { formatDateTime } from '../../backoffice/lib/i18n/format'
import './PublishPanel.css'
import { useActionLock } from '../../lib/useActionLock'

const indexTags = {
  building: { key: 'publish.indexBuilding', color: 'processing' },
  ready: { key: 'publish.indexReady', color: 'success' },
  missing: { key: 'publish.indexMissing', color: 'warning' },
  failed: { key: 'publish.indexFailed', color: 'error' },
} as const

const releaseModalMaxHeight = 'min(82dvh, calc(100dvh - 32px))'

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
  const [publishing, setPublishing] = useState(false)
  const [downloadReleaseId, setDownloadReleaseId] = useState<string | null>(null)
  const [rebuildingId, setRebuildingId] = useState<string | null>(null)
  const actions = useActionLock()
  const releaseRequests = useRef(new Map<string, Promise<void>>())

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

  const loadReleaseList = useCallback((courseId: string, fresh = false) => {
    const pending = releaseRequests.current.get(courseId)
    if (pending && !fresh) return pending
    const request = knowledgeApi.listReleases(courseId).then((releases) => {
      if (releaseRequests.current.get(courseId) === request) {
        setLatest((current) => ({ ...current, [courseId]: releases }))
      }
    }).finally(() => {
      if (releaseRequests.current.get(courseId) === request) releaseRequests.current.delete(courseId)
    })
    releaseRequests.current.set(courseId, request)
    return request
  }, [])

  const loadReleases = useCallback(async () => {
    await Promise.all(courses.map(({ id }) => loadReleaseList(id)))
  }, [courses, loadReleaseList])

  useEffect(() => {
    void loadReleases().catch((error: Error) => message.error(error.message))
  }, [loadReleases, message])

  const buildingCourseIds = Object.entries(latest)
    .filter(([id, releases]) => courses.some((course) => course.id === id) && releases.some((release) => release.indexStatus === 'building'))
    .map(([id]) => id)
    .join(',')

  useEffect(() => {
    if (!buildingCourseIds) return
    const courseIds = buildingCourseIds.split(',')
    let pending = false
    const timer = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        await Promise.allSettled(courseIds.map((id) => loadReleaseList(id)))
      } finally {
        pending = false
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [buildingCourseIds, loadReleaseList])

  const indexTag = (release: ReleaseSummary) => {
    if (!release.indexStatus) return null
    const tag = indexTags[release.indexStatus]
    return <Tag color={tag.color}>{text(tag.key, { count: release.indexChunkCount ?? 0 })}</Tag>
  }

  const doRebuildIndex = async (courseId: string, releaseId: string) => {
    const unlock = actions.acquire('rebuild')
    if (!unlock) return
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
      unlock()
    }
  }

  const doPublish = async () => {
    // 发布中再次触发（回车、连点）直接忽略，服务端另有重复提交保护
    if (!publishCourse || !notes.trim()) return
    const unlock = actions.acquire(publishCourse)
    if (!unlock) return
    setPublishing(true)
    try {
      await knowledgeApi.publish(publishCourse, notes.trim())
      message.success(text('publish.success'))
      setPublishCourse(null)
      setNotes('')
      await loadReleaseList(publishCourse, true).catch((error: Error) => message.error(error.message))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPublishing(false)
      unlock()
    }
  }

  const doActivate = (courseId: string, release: ReleaseSummary) => {
    const unlock = actions.acquire(courseId)
    if (!unlock) return
    const dialog = modal.confirm({
      afterClose: unlock,
      title: text('publish.activateTitle', { version: release.versionTag }),
      content: text(release.hasEditorSnapshot ? 'publish.activateContent' : 'publish.legacyActivateContent'),
      okText: text('publish.activateConfirm'),
      okButtonProps: { danger: true },
      cancelText: text('common.cancel'),
      onOk: async () => {
        dialog.update({ cancelButtonProps: { disabled: true }, keyboard: false })
        try {
          await knowledgeApi.activateRelease(courseId, release.id)
          message.success(text('publish.activated', { version: release.versionTag }))
          setHistoryCourse(null)
          await Promise.all([loadReleaseList(courseId, true), afterActivateRelease(courseId)])
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  /** 删除版本（§3.4.5，2026-10-20 新增）：Live / 后台测试所选版本无删除入口 */
  const doDelete = (courseId: string, release: ReleaseSummary) => {
    const unlock = actions.acquire(courseId)
    if (!unlock) return
    const dialog = modal.confirm({
      afterClose: unlock,
      title: text('publish.deleteTitle', { version: release.versionTag }),
      content: text('publish.deleteContent'),
      okText: text('tree.delete'),
      okButtonProps: { danger: true },
      cancelText: text('common.cancel'),
      onOk: async () => {
        dialog.update({ cancelButtonProps: { disabled: true }, keyboard: false })
        try {
          await knowledgeApi.deleteRelease(release.id)
          message.success(text('publish.deleted', { version: release.versionTag }))
          await loadReleaseList(courseId, true)
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
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
          <Button type="primary" size="small" disabled={actions.pending.has(record.id)} onClick={() => setPublishCourse(record.id)}>
            {text('publish.createRelease')}
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ]

  const historyList = historyCourse ? latest[historyCourse] ?? [] : []
  const historyBusy = Boolean(historyCourse && actions.pending.has(historyCourse))
  const downloadRelease = historyList.find(release => release.id === downloadReleaseId)

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
        closable={!historyBusy}
        keyboard={!historyBusy}
        onCancel={() => {
          if (historyCourse && actions.isLocked(historyCourse)) return
          setHistoryCourse(null)
          setDownloadReleaseId(null)
        }}
        centered
        width="min(924px, calc(100vw - 32px))"
        style={{ margin: 0 }}
        styles={{
          content: {
            boxSizing: 'border-box',
            height: releaseModalMaxHeight,
            display: 'flex',
            flexDirection: 'column',
          },
          body: { flex: 1, minHeight: 0, overflowY: 'auto' },
        }}
      >
        {historyCourse && access.canPublish && <ReleasePackageUpload key={historyCourse} courseId={historyCourse} disabled={historyBusy}
          acquire={() => actions.acquire(historyCourse)}
          onImported={() => loadReleaseList(historyCourse, true)} />}
        {historyList.length === 0 ? (
          <Typography.Text type="secondary">{text('publish.noHistory')}</Typography.Text>
        ) : (
          <TeachingTransferSection title={text('publish.versionRecords')}>
            {historyList.map(release => (
              <article key={release.id} className="release-history-row teaching-transfer-row">
                <div className="release-history-detail">
                  <div className="release-history-meta">
                    <strong>{release.versionTag}</strong>
                    {release.isEditing && <Tag color="green">{text('publish.tagEditing')}</Tag>}
                    {release.isActive && <Tag color="green">{text('publish.tagLive')}</Tag>}
                    {release.isTestSelected && <Tag>{text('publish.tagTesting')}</Tag>}
                    <time className="teaching-transfer-muted" dateTime={release.createdAt}>{formatDateTime(locale, release.createdAt)}</time>
                  </div>
                  {release.revisionNotes && <div>{release.revisionNotes}</div>}
                  <div className="release-history-index">
                    {indexTag(release)}
                    {access.canPublish && historyCourse && release.indexStatus && release.indexStatus !== 'building' && (
                      <Button size="small" disabled={rebuildingId !== null} loading={rebuildingId === release.id}
                        onClick={() => void doRebuildIndex(historyCourse, release.id)}>
                        {text('publish.rebuildIndex')}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="release-history-actions">
                  <Button size="small" icon={<DownloadOutlined />}
                    aria-label={text('publish.downloadVersionAria', { version: release.versionTag })}
                    onClick={() => setDownloadReleaseId(release.id)}>
                    {text('publish.downloadVersion')}
                  </Button>
                  <Button size="small" onClick={() => {
                    if (previewId === release.id) return
                    setSnapshot(null)
                    setPreviewId(release.id)
                  }}>{text('editor.preview')}</Button>
                  {access.canPublish && historyCourse && !release.isEditing && (
                    <Button size="small" disabled={actions.pending.has(historyCourse)}
                      onClick={() => doActivate(historyCourse, release)}>{text('publish.switchTo')}</Button>
                  )}
                  {access.canDelete && historyCourse && !release.isActive && !release.isTestSelected && (
                    <Button type="text" size="small" danger
                      aria-label={text('publish.deleteVersionAria', { version: release.versionTag })}
                      disabled={actions.pending.has(historyCourse)}
                      onClick={() => doDelete(historyCourse, release)}>
                      <CloseIcon size={16} />
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </TeachingTransferSection>
        )}
      </Modal>

      {downloadRelease && <ReleaseDownloadModal key={downloadRelease.id} release={downloadRelease}
        close={() => setDownloadReleaseId(null)} />}

      <Modal open={!!previewId} title={text('publish.versionPreviewTitle')} width={800} centered style={{ margin: 0 }}
        classNames={{ body: 'release-preview-body' }}
        styles={{
          content: { boxSizing: 'border-box', maxHeight: releaseModalMaxHeight, display: 'flex', flexDirection: 'column' },
          header: { flexShrink: 0 },
          footer: { flexShrink: 0 },
        }}
        footer={<Button onClick={() => setPreviewId('')}>{text('publish.backToHistory')}</Button>}
        onCancel={() => setPreviewId('')}>
        {!snapshot ? <Spin /> : <>
          <p className="teaching-transfer-course"><strong>{snapshot.versionTag}</strong> {formatDateTime(locale, snapshot.createdAt)}</p>
          <TeachingTransferSection title={text('publish.pageSnapshot')} actions={
            <Select className="release-history-pages" aria-label={text('teaching.sourcePage')} value={pageId || undefined} onChange={setPageId}
              options={snapshot.snapshotData.pages.map(page => ({ value: page.id, label: page.title }))} />
          }>
            {previewPage && <div key={previewPage.id} className="release-preview-page teaching-transfer-inset"
              role="region" aria-label={previewPage.title} tabIndex={0} data-color-mode="light">
              <KnowledgeMarkdown source={previewPage.contentMd} courseId={snapshot.courseId}
                references={snapshot.snapshotData.teachingPackage?.cards.flatMap(card => card.approvedPayload?.refObjects ?? []) ?? []} />
            </div>}
          </TeachingTransferSection>
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
        okButtonProps={{ disabled: !notes.trim() || publishing }}
        cancelButtonProps={{ disabled: publishing }}
        closable={!publishing}
        keyboard={!publishing}
        maskClosable={!publishing}
        onOk={doPublish}
        onCancel={() => {
          if (publishCourse && actions.isLocked(publishCourse)) return
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
