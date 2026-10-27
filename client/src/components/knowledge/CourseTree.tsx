import { useEffect, useMemo, useState } from 'react'
import { App, Dropdown, Tree, Modal, Input, Tooltip, Empty } from '../ui'
import type { TreeDataNode } from '../ui'
import {
  HolderOutlined,
  MoreOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { UploadDocumentModal } from './UploadDocumentModal'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'
import { PageFileIcon } from '../icons'

/** heading 信息：层级(1-6) + 文本 */
interface HeadingInfo {
  level: number
  text: string
}

/** 目录缩进（2026-10-22）：Page 行左侧呼吸空间；Heading 按 H1-H6 逐级缩进 */
const PAGE_INDENT = 6
const HEADING_BASE_INDENT = 28
const HEADING_LEVEL_STEP = 12

/** 解析 markdown 提取 H1-H6（用于 TOC，2026-10-19 由 H1/H2/H3 扩展） */
function parseHeadings(contentMd: string): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  for (const line of contentMd.split('\n')) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() })
    }
  }
  return headings
}

/**
 * 课程目录树（§3.2.1；2026-10-16 扁平化 + TOC）：Course → Page → Heading(H1-H6，2026-10-19 扩展)。
 * - 树按同步目标过滤
 * - 隐藏原生展开箭头，点击行展开/收起，行尾 chevron 提示
 * - Page 节点点击选中→编辑器加载；chevron 展开其下 Heading 目录（TOC）
 * - Heading 节点点击→编辑器滚动定位
 * - Page 菜单：新建页面、上传文档建页、删除页面
 */
export function CourseTree({ keyword }: { keyword: string }) {
  const { message, modal } = App.useApp()
  /** PRD §3.2/§3.3：新建/删除是 CREATE/DELETE 级写操作，View/Edit 角色不显示 */
  const access = useWorkspaceAccess()
  const courses = useKnowledgeStore((s) => s.courses)
  const details = useKnowledgeStore((s) => s.details)
  const selectedPageId = useKnowledgeStore((s) => s.selectedPageId)
  const selectedCourseId = useKnowledgeStore((s) => s.selectedCourseId)
  const selectedExternalId = useKnowledgeStore((s) => s.selectedExternalId)
  const externalCourses = useKnowledgeStore((s) => s.externalCourses)
  const selectPage = useKnowledgeStore((s) => s.selectPage)
  const createPage = useKnowledgeStore((s) => s.createPage)
  const deleteCourse = useKnowledgeStore((s) => s.deleteCourse)
  const deletePage = useKnowledgeStore((s) => s.deletePage)
  const reorderPages = useKnowledgeStore((s) => s.reorderPages)
  const scrollToHeading = useKnowledgeStore((s) => s.scrollToHeading)

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [inputState, setInputState] = useState<{
    kind: 'page'
    courseId: string
  } | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [uploadTarget, setUploadTarget] = useState<{
    courseId: string
    courseTitle: string
  } | null>(null)

  /** 拖拽排序状态（§3.2.1，2026-10-19）：正在拖拽的 Page id + 当前落点指示 */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    pageId: string
    pos: 'before' | 'after'
  } | null>(null)

  const visibleCourseId = useMemo(() => {
    if (!selectedExternalId) return null
    return (
      externalCourses.find((e) => e.externalId === selectedExternalId)
        ?.localCourseId ?? null
    )
  }, [externalCourses, selectedExternalId])

  /** 未选同步目标时默认展示全部课件（BUG-0227）；选了目标则只显示该目标对应的本地课程 */
  const showAll = !selectedExternalId
  const visibleCourseIds = useMemo(
    () =>
      showAll
        ? courses.map((c) => c.id)
        : visibleCourseId
          ? [visibleCourseId]
          : [],
    [courses, showAll, visibleCourseId],
  )
  const courseKeys = useMemo(
    () => visibleCourseIds.map((id) => `course:${id}`),
    [visibleCourseIds],
  )

  // 全部课件视图：课程节点全部展开，并补拉尚未加载的课程详情
  useEffect(() => {
    if (!showAll) return
    setExpandedKeys((prev) => [
      ...courseKeys,
      ...prev.filter((k) => !String(k).startsWith('course:')),
    ])
    const st = useKnowledgeStore.getState()
    for (const id of visibleCourseIds) {
      if (!st.details[id]) void st.refreshDetail(id)
    }
  }, [showAll, courseKeys, visibleCourseIds])

  // 目标课程变化：自动展开 + 加载详情 + 恢复上次编辑页
  useEffect(() => {
    if (showAll) return
    if (!visibleCourseId) {
      setExpandedKeys([])
      return
    }
    setExpandedKeys([`course:${visibleCourseId}`])
    void (async () => {
      const st = useKnowledgeStore.getState()
      if (!st.details[visibleCourseId]) {
        await st.refreshDetail(visibleCourseId)
      }
      const last = st.lastPageIdByCourse[visibleCourseId]
      const detail = useKnowledgeStore.getState().details[visibleCourseId]
      const exists = detail?.pages.some((p) => p.id === last)
      if (last && exists && st.selectedPageId !== last) {
        await st.selectPage(visibleCourseId, last)
      }
    })()
  }, [showAll, visibleCourseId])

  const kw = keyword.trim().toLowerCase()

  /** 拖拽排序启用条件：无搜索过滤（过滤后可见顺序不完整，不能据此排序）；View 角色只读，不允许排序；
   *  全部课件视图不排序（排序按单个课程计算） */
  const dragEnabled = !kw && access.canEdit && !!visibleCourseId
  /** 当前课程全部 Page 顺序（不受搜索过滤影响，用于计算拖拽后的新顺序） */
  const pageOrder = useMemo(
    () =>
      visibleCourseId
        ? (details[visibleCourseId]?.pages ?? []).map((p) => p.id)
        : [],
    [details, visibleCourseId],
  )

  const treeData = useMemo<TreeDataNode[]>(() => {
    return courses
      .filter((course) => visibleCourseIds.includes(course.id))
      .map((course) => {
        const detail = details[course.id]
        const pages = (detail?.pages ?? []).flatMap((p) => {
          const titleMatch = p.title.toLowerCase().includes(kw)
          const headings = parseHeadings(p.contentMd)
          // 搜索口径（§3.2.1，2026-10-19）：匹配 Page 标题 + 全部 Heading（不含正文）。
          // 标题命中→显示该页全部 Heading；仅 Heading 命中→只显示匹配的 Heading；无关键字→全部 H1-H6。
          const visibleHeadings = !kw
            ? headings
            : titleMatch
              ? headings
              : headings.filter((h) => h.text.toLowerCase().includes(kw))
          if (kw && !titleMatch && visibleHeadings.length === 0) return []

          // index 用于区分同层级同文本的重复 Heading，避免 Tree key 冲突
          const headingNodes: TreeDataNode[] = visibleHeadings.map((h, index) => ({
            key: `heading:${course.id}:${p.id}:${h.level}:${index}:${h.text}`,
            title: h.text,
            isLeaf: true,
            _level: h.level,
            _ops: { courseId: course.id, pageId: p.id, heading: h.text } as const,
          }))
          return [
            {
              key: `page:${course.id}:${p.id}`,
              title: p.title,
              children: headingNodes,
              _stale: p.syncState === 'STALE',
              _ops: { courseId: course.id, pageId: p.id } as const,
            },
          ]
        })
        if (kw && pages.length === 0) return null
        return {
          key: `course:${course.id}`,
          title: course.title,
          selectable: false,
          children: pages,
          _ops: { courseId: course.id } as const,
        }
      })
      .filter(Boolean) as TreeDataNode[]
  }, [courses, details, kw, visibleCourseIds])

  // 搜索时自动展开命中分支
  useEffect(() => {
    if (!kw) return
    const keys: React.Key[] = []
    for (const node of treeData) {
      keys.push(node.key)
      for (const page of node.children ?? []) {
        keys.push(page.key)
      }
    }
    setExpandedKeys(keys)
  }, [kw, treeData])

  const handleSelect = (keys: React.Key[]) => {
    const key = keys[0]
    if (typeof key !== 'string') return
    if (key.startsWith('page:')) {
      const [, courseId, pageId] = key.split(':')
      // 2026-10-22 修复：点击当前已选 Page 只做展开/收起，不重新 selectPage。
      // 否则会重置 draft 并触发编辑器 replaceBlocks，反复操作会出现重复 Heading。
      if (courseId !== selectedCourseId || pageId !== selectedPageId) {
        void selectPage(courseId, pageId)
      }
    } else if (key.startsWith('heading:')) {
      // heading:courseId:pageId:level:index:text
      const parts = key.split(':')
      const courseId = parts[1]
      const pageId = parts[2]
      const heading = parts.slice(5).join(':')
      // 跨文件：先切换到目标页面，再滚动到 heading
      if (pageId !== selectedPageId) {
        void (async () => {
          await selectPage(courseId, pageId)
          // 等待编辑器加载完成后再滚动（PageEditor 的 effect 会监听 tocScrollTarget）
          scrollToHeading(heading)
        })()
      } else {
        scrollToHeading(heading)
      }
    }
  }

  const toggleRow = (key: string) => {
    // course 节点始终展开，不允许折叠
    if (key.startsWith('course:')) return
    setExpandedKeys((prev) => {
      if (prev.map(String).includes(key)) {
        return prev.filter((k) => String(k) !== key)
      }
      return [...prev, key]
    })
  }

  const handleExpand = (keys: React.Key[]) => {
    // course 节点始终保持展开
    const filtered = keys.filter((k) => !courseKeys.includes(String(k)))
    setExpandedKeys([...courseKeys, ...filtered])
  }

  /** 拖拽落点判定：指针位于行的上半→插到目标之前，下半→之后 */
  const resolveDropPos = (e: React.DragEvent): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  /** 拖拽结束：把 fromId 移动到 targetId 的前/后，调用批量排序接口持久化 */
  const performReorder = async (
    fromId: string,
    targetId: string,
    pos: 'before' | 'after',
  ) => {
    if (!visibleCourseId || fromId === targetId) return
    const next = [...pageOrder]
    const fromIdx = next.indexOf(fromId)
    if (fromIdx < 0) return
    next.splice(fromIdx, 1)
    let toIdx = next.indexOf(targetId)
    if (toIdx < 0) return
    if (pos === 'after') toIdx += 1
    next.splice(toIdx, 0, fromId)
    // 顺序无变化则不发请求
    if (next.every((id, i) => id === pageOrder[i])) return
    try {
      await reorderPages(visibleCourseId, next)
    } catch (e) {
      message.error((e as Error).message || '排序保存失败')
    }
  }

  const openCreate = (courseId: string) => {
    setInputState({ kind: 'page', courseId })
    setInputValue('')
  }

  const submitCreate = async () => {
    if (!inputState || !inputValue.trim()) return
    const { courseId } = inputState
    try {
      await createPage(courseId, inputValue.trim())
      setInputState(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const confirmDelete = (label: string, action: () => Promise<void>) => {
    modal.confirm({
      title: `删除${label}？`,
      content: '该操作不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await action()
          message.success('已删除')
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  const openUpload = (courseId: string, courseTitle: string) => {
    setUploadTarget({ courseId, courseTitle })
  }

  const menuFor = (node: TreeDataNode) => {
    const ops = (
      node as unknown as {
        _ops?: { courseId: string; pageId?: string; heading?: string }
      }
    )._ops
    if (!ops) return null
    if (ops.heading) return null // heading 节点无菜单
    if (ops.pageId) {
      if (!access.canDelete) return null
      return {
        items: [{ key: 'del-page', label: '删除页面', danger: true }],
        onClick: ({ key }: { key: string }) => {
          if (key === 'del-page')
            confirmDelete('页面', () => deletePage(ops.courseId, ops.pageId!))
        },
      }
    }
    const courseItems: { key: string; label: string; danger?: boolean }[] = []
    if (access.canCreate) {
      courseItems.push({ key: 'new-page', label: '新建页面' })
      courseItems.push({ key: 'upload', label: '上传文档建页' })
    }
    if (access.canDelete) {
      courseItems.push({ key: 'del-course', label: '删除课程', danger: true })
    }
    if (courseItems.length === 0) return null
    return {
      items: courseItems,
      onClick: ({ key }: { key: string }) => {
        if (key === 'new-page') openCreate(ops.courseId)
        if (key === 'upload') openUpload(ops.courseId, node.title as string)
        if (key === 'del-course')
          confirmDelete('课程', () => deleteCourse(ops.courseId))
      },
    }
  }

  if (showAll && courses.length === 0) {
    return (
      <span style={{ fontSize: tokens.fontSize.md, color: tokens.color.text.tertiary }}>
        暂无课件，请在上方选择同步目标后 Sync
      </span>
    )
  }
  if (!showAll && !visibleCourseId) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span style={{ fontSize: tokens.fontSize.md }}>
            该课程尚未同步，点击下方 Sync 拉取
          </span>
        }
      />
    )
  }

  return (
    <>
      <div className="course-tree-no-switcher">
        {kw && treeData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ fontSize: tokens.fontSize.md }}>无匹配结果</span>
            }
          />
        ) : (
          <Tree
            blockNode
            treeData={treeData}
            expandedKeys={expandedKeys}
            selectedKeys={
              selectedCourseId && selectedPageId
                ? [`page:${selectedCourseId}:${selectedPageId}`]
                : []
            }
            onExpand={handleExpand}
            onSelect={handleSelect}
            titleRender={(node) => {
            const stale = (node as unknown as { _stale?: boolean })._stale
            const level = (node as unknown as { _level?: number })._level
            const key = String(node.key)
            const isCourse = key.startsWith('course:')
            const isPage = key.startsWith('page:')
            const isHeading = key.startsWith('heading:')
            const expanded = expandedKeys.map(String).includes(key)
            // Page 点击行为：
            // - 点击当前选中的 page → 切换展开/折叠其 Heading 目录
            // - 点击其他 page → 只切换文件（由 onSelect 处理），不展开/折叠
            // - course 始终展开，不可折叠
            const pageId = isPage ? key.split(':')[2] : null
            const pid = pageId ?? ''
            const isCurrentPage = pageId === selectedPageId
            const onRowClick =
              isPage && isCurrentPage ? () => toggleRow(key) : undefined
            // 拖拽排序（§3.2.1，2026-10-19）：仅 Page 行可作为落点，搜索过滤时禁用
            const isDropTarget = isPage && dropTarget?.pageId === pid
            const canDropHere =
              isPage && dragEnabled && !!draggingId && draggingId !== pid
            const isDragging = isPage && draggingId === pid
            // 2026-10-22：Heading 字号不随层级变小，统一与 Page 一致
            const headingLevel = isHeading ? Math.max(1, Math.min(6, level ?? 1)) : 0
            const headingFontSize = tokens.fontSize.md
            // 缩进：Page 左侧留呼吸空间；Heading 按 H1-H6 逐级缩进
            const paddingLeft = isPage
              ? PAGE_INDENT
              : isHeading
                ? HEADING_BASE_INDENT + (headingLevel - 1) * HEADING_LEVEL_STEP
                : 0
            return (
              <div
                className="course-tree-row"
                style={{
                  position: 'relative',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  width: '100%',
                  minWidth: 0,
                  boxSizing: 'border-box',
                  paddingLeft,
                  opacity: isDragging ? 0.4 : 1,
                  boxShadow: isDropTarget
                    ? dropTarget!.pos === 'before'
                      ? `inset 0 2px 0 ${tokens.color.primary}`
                      : `inset 0 -2px 0 ${tokens.color.primary}`
                    : undefined,
                }}
                onClick={onRowClick}
                onDragOver={
                  canDropHere
                    ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        e.dataTransfer.dropEffect = 'move'
                        const pos = resolveDropPos(e)
                        setDropTarget((prev) =>
                          prev?.pageId === pid && prev.pos === pos
                            ? prev
                            : { pageId: pid, pos },
                        )
                      }
                    : undefined
                }
                onDragLeave={
                  canDropHere
                    ? (e) => {
                        // 指针移入子元素不算离开本行
                        if (
                          (e.currentTarget as HTMLElement).contains(
                            e.relatedTarget as Node,
                          )
                        )
                          return
                        setDropTarget((prev) =>
                          prev?.pageId === pid ? null : prev,
                        )
                      }
                    : undefined
                }
                onDrop={
                  canDropHere
                    ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const pos = resolveDropPos(e)
                        void performReorder(draggingId!, pid, pos)
                        setDraggingId(null)
                        setDropTarget(null)
                      }
                    : undefined
                }
              >
                {/* Heading 引导线：H2-H6 显示祖先层级竖线（2026-10-22） */}
                {isHeading &&
                  headingLevel > 1 &&
                  Array.from({ length: headingLevel - 1 }, (_, i) => (
                    <span
                      key={`guide-${i}`}
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: HEADING_BASE_INDENT + i * HEADING_LEVEL_STEP - 6,
                        width: 1,
                        background: tokens.color.border,
                        pointerEvents: 'none',
                      }}
                    />
                  ))}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: tokens.spacing.xs + 2,
                    flex: 1,
                    minWidth: 0,
                    fontSize: isHeading
                      ? headingFontSize
                      : isCourse
                        ? tokens.fontSize.xl
                        : tokens.fontSize.md,
                    fontWeight: isHeading
                      ? undefined
                      : isCourse
                        ? tokens.fontWeight.semibold
                        : tokens.fontWeight.medium,
                    color: isHeading
                      ? undefined
                      : isCourse
                        ? tokens.color.primary
                        : tokens.color.text.primary,
                  }}
                >
                  {isPage && dragEnabled && (
                    <span
                      className="page-drag-handle"
                      draggable
                      title="拖拽调整顺序"
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e) => {
                        e.stopPropagation()
                        e.dataTransfer.effectAllowed = 'move'
                        // 部分浏览器必须 setData 才会触发后续拖拽事件
                        e.dataTransfer.setData('text/plain', pid)
                        setDraggingId(pid)
                      }}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setDropTarget(null)
                      }}
                    >
                      <HolderOutlined />
                    </span>
                  )}
                  {isPage ? (
                    <PageFileIcon
                      size={16}
                      color={tokens.color.text.secondary}
                    />
                  ) : isHeading ? (
                    <span
                      style={{
                        display: 'inline-block',
                        flexShrink: 0,
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        background: tokens.color.text.tertiary,
                      }}
                    />
                  ) : null}
                  {stale ? (
                    <Tooltip title="该节点与外部源不同步，不会作为 AI Tutor 知识库使用">
                      <span
                        style={{
                          display: 'block',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: tokens.color.text.disabled,
                          fontStyle: 'italic',
                        }}
                      >
                        {node.title as string}
                      </span>
                    </Tooltip>
                  ) : (
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {node.title as string}
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: tokens.spacing.xs }}>
                  {isPage && (
                    <RightOutlined
                      style={{
                        fontSize: tokens.fontSize.xs,
                        color: tokens.color.text.tertiary,
                        transition: 'transform 0.2s',
                        transform: expanded ? 'rotate(90deg)' : 'none',
                      }}
                    />
                  )}
                  {menuFor(node) && (
                    <Dropdown menu={menuFor(node)!} trigger={['click']}>
                      <MoreOutlined
                        onClick={(e) => e.stopPropagation()}
                        style={{ padding: `0 ${tokens.spacing.xs}px` }}
                      />
                    </Dropdown>
                  )}
                </span>
              </div>
            )
          }}
        />
        )}
      </div>
      <UploadDocumentModal
        target={uploadTarget}
        onClose={() => setUploadTarget(null)}
      />
      <Modal
        open={!!inputState}
        title="新建页面"
        okText="创建"
        cancelText="取消"
        onOk={submitCreate}
        onCancel={() => setInputState(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="页面名称"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={submitCreate}
        />
      </Modal>
    </>
  )
}
