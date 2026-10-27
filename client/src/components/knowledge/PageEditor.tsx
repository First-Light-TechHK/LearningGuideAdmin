import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, App, Button, Dropdown, Empty, Input, Panel, Tag } from '../ui'
import type { MenuProps } from '../ui'
import { EditOutlined, EyeOutlined } from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { clearLocalDraft, localDraftKey, registerDraftFlusher, useKnowledgeStore } from '../../stores/knowledgeStore'
import { MarkdownSourceEditor } from './MarkdownSourceEditor'
import { MarkdownToolbar } from './MarkdownToolbar'
import { insertSnippet, toggleLinePrefix } from './markdownCommands'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

/**
 * Page 编辑器（2026-10-29 改版：Markdown 源码编辑 + 预览）。
 *
 * 背景：原 BlockNote 富文本块编辑器在大文档（数百 block）下「选中文字即卡死」，
 * 经排查是结构性成本（整页一个 ProseMirror contenteditable、无虚拟化、文档级选区），
 * 关闭浮动 UI 后无改善。故改为 CodeMirror 6 纯 Markdown 源码编辑器：
 *  - CM6 原生视口虚拟化，选中/布局成本与文档大小无关；
 *  - 内容直接就是 contentMd（真源），不再有 blocks ↔ markdown 的整篇序列化；
 *  - 跨块选中、撤销/重做、查找都是 CM6 免费能力。
 * 标题栏右侧提供「预览」按钮，用与 Portal 相同的渲染器（remark-math + rehype-katex）展示效果。
 */

const SAVE_LABEL: Record<string, { text: string; color: string }> = {
  idle: { text: '', color: '' },
  dirty: { text: '未保存…', color: 'orange' },
  saving: { text: '保存中…', color: 'blue' },
  saved: { text: '已保存', color: 'green' },
  error: { text: '保存失败', color: 'red' },
}

/** 与 AI Tutor / Portal 一致的 Markdown+KaTeX 渲染插件 */
const katexPlugins = {
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
}

/** 浏览器刷新/关闭页面时的本地草稿兜底 key（与 store 共用，保持单一 key 规则） */
interface LocalDraft {
  contentMd?: string
  title?: string
  sectionTags?: Record<string, string[]>
  savedAt?: number
}

/** 本地草稿时间展示（恢复确认弹窗用） */
function formatSavedAt(savedAt?: number): string {
  if (!savedAt) return ''
  try {
    return new Date(savedAt).toLocaleString()
  } catch {
    return ''
  }
}

/** 把编辑器滚动到指定标题文本所在行（TOC 点击跳转） */
function scrollToHeading(view: EditorView, headingText: string) {
  const target = headingText.trim()
  if (!target) return
  const doc = view.state.doc
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line.text)
    if (m && m[1].trim() === target) {
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      view.focus()
      return
    }
  }
}

export function PageEditor() {
  const draft = useKnowledgeStore((s) => s.draft)
  const editDraft = useKnowledgeStore((s) => s.editDraft)
  const tocScrollTarget = useKnowledgeStore((s) => s.tocScrollTarget)
  const clearTocScrollTarget = useKnowledgeStore((s) => s.clearTocScrollTarget)
  const { modal } = App.useApp()
  /** PRD §3.2/§3.3：View 角色只读，Edit/Full 才可改既有内容 */
  const access = useWorkspaceAccess()

  /** 预览态：只读渲染 contentMd（与 Portal 渲染一致） */
  const [preview, setPreview] = useState(false)
  /** 编辑器实例（供常驻工具条使用；CM6 非受控，需要 React 侧拿到 view） */
  const [view, setView] = useState<EditorView | null>(null)
  /** 标题编辑态（§3.3.1）：默认展示态（大标题 + 常显铅笔），点击铅笔进入编辑态 */
  const [editingTitle, setEditingTitle] = useState(false)
  const titleBeforeEdit = useRef('')

  const viewRef = useRef<EditorView | null>(null)
  /** 写回 draft 的防抖定时器 + 稳定回调（供防抖与 store flusher 共用） */
  const commitTimerRef = useRef<number | null>(null)
  const commitRef = useRef<() => void>(() => {})
  /** 预览态时点击 TOC 的待跳转标题（编辑器重新挂载后执行） */
  const pendingHeadingRef = useRef<string | null>(null)

  /** 把编辑器当前文本写入 draft —— 直接取 CM6 文档字符串，无序列化成本 */
  const commitNow = () => {
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    const view = viewRef.current
    if (!view) return
    const md = view.state.doc.toString()
    const cur = useKnowledgeStore.getState().draft
    if (md !== cur?.contentMd) editDraft({ contentMd: md })
  }
  useLayoutEffect(() => {
    commitRef.current = commitNow
  })

  /** 输入：300ms 防抖写回 draft，避免每次按键都触发组件重渲染 */
  const onEditorChange = () => {
    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current)
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null
      commitRef.current()
    }, 300)
  }

  /** 编辑器挂载/销毁回调；预览态下的待跳转在此执行 */
  const onViewReady = (next: EditorView | null) => {
    viewRef.current = next
    setView(next)
    if (next && pendingHeadingRef.current) {
      scrollToHeading(next, pendingHeadingRef.current)
      pendingHeadingRef.current = null
    }
  }

  /** 注册序列化/落盘回调给 store：保存、切页、离开编辑页前都会先调用它 */
  useEffect(() => {
    registerDraftFlusher(() => commitRef.current())
    return () => {
      commitRef.current()
      void useKnowledgeStore.getState().flushSave()
      registerDraftFlusher(null)
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current)
        commitTimerRef.current = null
      }
    }
  }, [])

  // 切换页面：退出预览态，回到源码编辑
  useEffect(() => {
    setPreview(false)
  }, [draft?.pageId])

  // TOC 跳转：源码态直接定位；预览态先切回编辑再定位
  useEffect(() => {
    if (!tocScrollTarget) return
    const target = tocScrollTarget.trim()
    const view = viewRef.current
    if (view && target) {
      scrollToHeading(view, target)
    } else if (target) {
      pendingHeadingRef.current = target
      setPreview(false)
    }
    clearTocScrollTarget()
  }, [tocScrollTarget, clearTocScrollTarget])

  /** 刷新/关闭标签页/切到后台时：仅在「确实未保存」时写本地草稿，避免为已保存内容留陈旧快照 */
  useEffect(() => {
    const persistToLocal = () => {
      try {
        commitRef.current()
        const cur = useKnowledgeStore.getState().draft
        // 只有 dirty/saving/error 才需要兜底；saved/idle 写进去会在下次打开时被误判为未保存草稿
        if (!cur || (cur.saveState !== 'dirty' && cur.saveState !== 'saving' && cur.saveState !== 'error')) return
        localStorage.setItem(
          localDraftKey(cur.pageId),
          JSON.stringify({
            contentMd: cur.contentMd,
            title: cur.title,
            sectionTags: cur.sectionTags,
            savedAt: Date.now(),
          } satisfies LocalDraft),
        )
      } catch {
        /* 本地存储不可用/已满：忽略 */
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistToLocal()
    }
    window.addEventListener('pagehide', persistToLocal)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', persistToLocal)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  /** 打开页面时若存在本地草稿且与服务端内容/标题不同，询问是否恢复（防刷新/崩溃丢稿）。
   *  注：本地草稿的清理由 store 统一负责（保存成功/切页/激活/删除页），此处只读不删，
   *  避免组件卸载后残留 key 被误认为「未保存」。 */
  const checkedDraftRef = useRef<string | null>(null)
  useEffect(() => {
    if (!access.canEdit) return
    const st = useKnowledgeStore.getState()
    const d = st.draft
    if (!d) return
    if (checkedDraftRef.current === d.pageId) return
    checkedDraftRef.current = d.pageId
    let local: LocalDraft | null = null
    try {
      const raw = localStorage.getItem(localDraftKey(d.pageId))
      local = raw ? (JSON.parse(raw) as LocalDraft) : null
    } catch {
      local = null
    }
    if (!local || typeof local.contentMd !== 'string') return
    // 只在「当前内存草稿已落库(idle/saved)」时提示恢复：否则内存里的编辑比本地快照更新，
    // 「恢复」会用更旧的快照覆盖更新内容。
    if (d.saveState !== 'idle' && d.saveState !== 'saved') return
    // 正文与标题都一致才算「无未保存修改」
    if (local.contentMd === d.contentMd && (local.title ?? d.title) === d.title) {
      clearLocalDraft(d.pageId)
      return
    }
    const pageId = d.pageId
    const when = formatSavedAt(local.savedAt)
    modal.confirm({
      title: '发现本地未保存的草稿',
      content: `本地草稿${when ? `（保存于 ${when}）` : ''}与服务器版本不同，可能包含尚未保存的修改，是否恢复？`,
      okText: '恢复',
      cancelText: '丢弃',
      onOk: () => {
        useKnowledgeStore.getState().editDraft({
          contentMd: local?.contentMd ?? '',
          title: local?.title ?? d.title,
          sectionTags: local?.sectionTags ?? d.sectionTags,
        })
      },
      onCancel: () => clearLocalDraft(pageId),
    })
  }, [draft?.pageId, access.canEdit, modal])

  /** 临时诊断（仅开发模式）：主线程 >120ms 的长任务；验证改版效果后可删除 */
  useEffect(() => {
    if (!import.meta.env.DEV || typeof PerformanceObserver === 'undefined') return
    let observer: PerformanceObserver
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 120) console.warn(`[kg-perf] long task ${entry.duration.toFixed(0)}ms`)
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      return
    }
    return () => observer.disconnect()
  }, [])

  if (!draft) {
    // 空状态同样套内容面板（2026-10-19 修正）：确保未选中页面时内容区仍显示白色圆角面板，三区外观统一
    return (
      <Panel
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Empty description="从左侧目录树选择一个页面开始编辑" />
      </Panel>
    )
  }

  const save = SAVE_LABEL[draft.saveState]
  const borderStyle: React.CSSProperties = {
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
  }

  /** 插入模板，并把光标/选区落到 `marker` 处（便于直接替换占位文字）；块级片段自动断行 */
  const insertWithSelection = (template: string, marker?: string) => {
    const target = viewRef.current
    if (!target) return
    const idx = marker ? template.indexOf(marker) : -1
    if (!marker || idx < 0) {
      insertSnippet(target, template, { block: true })
      return
    }
    insertSnippet(target, template, { select: { from: idx, to: idx + marker.length }, block: true })
  }

  /** 右键插入菜单（M1）：表格 / 公式 / 图片 / 代码块 / 引用 / 分割线 */
  const insertMenuItems: MenuProps['items'] = [
    { key: 'table', label: '插入表格' },
    { key: 'mathBlock', label: '插入公式块 $$…$$' },
    { key: 'inlineMath', label: '插入行内公式 $…$' },
    { key: 'image', label: '插入图片 ![](url)' },
    { key: 'code', label: '插入代码块' },
    { key: 'quote', label: '插入引用' },
    { key: 'divider', label: '插入分割线' },
  ]

  const onInsertMenuClick: MenuProps['onClick'] = ({ key }) => {
    const target = viewRef.current
    if (!target) return
    if (key === 'table') {
      insertWithSelection('| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 |  |  |', '列 1')
    } else if (key === 'mathBlock') {
      insertWithSelection('$$\nE = mc^2\n$$', 'E = mc^2')
    } else if (key === 'inlineMath') {
      // 行内片段：不补空行，插入 `$x$` 并选中 x
      insertSnippet(target, '$x$', { select: { from: 1, to: 2 } })
    } else if (key === 'image') {
      insertWithSelection('![图片描述](https://)', 'https://')
    } else if (key === 'code') {
      insertWithSelection('```\n在此写代码\n```', '在此写代码')
    } else if (key === 'quote') {
      toggleLinePrefix(target, () => '> ', /^(\s*)(>)(\s)/)
    } else if (key === 'divider') {
      insertSnippet(target, '---', { block: true })
    }
  }

  return (
    // 内容面板（2026-10-19 对齐 Figma）：白色/圆角12/无边框/卡片阴影，与 AI Tutor、Releases 统一
    <Panel style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 标题区（§3.3.1）：默认展示态（大标题 + 常显铅笔），支持就地编辑；最右侧为保存状态 + 预览开关 */}
      <div
        style={{
          display: 'flex',
          gap: tokens.spacing.sm,
          alignItems: 'center',
          marginBottom: tokens.spacing.sm,
          paddingBottom: tokens.spacing.sm,
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        {editingTitle && access.canEdit ? (
          <Input
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 30,
              fontWeight: tokens.fontWeight.bold,
              lineHeight: '36px',
              color: '#000000',
            }}
            value={draft.title}
            onChange={(e) => editDraft({ title: e.target.value })}
            onPressEnter={() => setEditingTitle(false)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Esc 取消：回滚到进入编辑前的标题
                editDraft({ title: titleBeforeEdit.current })
                setEditingTitle(false)
              }
            }}
            placeholder="未命名页面"
          />
        ) : (
          <>
            <div
              style={{
                minWidth: 0,
                fontSize: 30,
                fontWeight: tokens.fontWeight.bold,
                lineHeight: '36px',
                color: '#000000',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {draft.title || '未命名页面'}
            </div>
            {access.canEdit && (
              <Button
                type="text"
                aria-label="编辑标题"
                title="编辑标题"
                icon={<EditOutlined style={{ fontSize: 16 }} />}
                onClick={() => {
                  titleBeforeEdit.current = draft.title
                  setEditingTitle(true)
                }}
                style={{
                  width: 20,
                  height: 20,
                  minWidth: 20,
                  padding: 0,
                  color: tokens.color.text.tertiary,
                }}
              />
            )}
          </>
        )}
        {/* 右侧：保存状态 + 预览/编辑切换（2026-10-29 新增预览按钮） */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.sm,
            flexShrink: 0,
          }}
        >
          {save.text && <Tag color={save.color}>{save.text}</Tag>}
          <Button
            size="small"
            icon={preview ? <EditOutlined /> : <EyeOutlined />}
            onClick={() => {
              // 切到预览前先把最新文本写回 draft，保证预览内容与编辑器一致
              if (!preview) commitRef.current()
              setPreview((v) => !v)
            }}
          >
            {preview ? '编辑' : '预览'}
          </Button>
        </div>
      </div>
      {draft.saveState === 'error' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.sm,
            marginBottom: tokens.spacing.sm,
          }}
        >
          <Alert
            type="error"
            showIcon
            message="自动保存失败：切页/切课程会被阻断，避免丢稿（修改仍保留在本地）"
            style={{ flex: 1 }}
          />
          <Button size="small" onClick={() => void useKnowledgeStore.getState().flushSave()}>
            重试
          </Button>
        </div>
      )}
      {preview ? (
        <div
          data-color-mode="light"
          style={{
            ...borderStyle,
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: `${tokens.spacing.md}px ${tokens.spacing.lg}px`,
          }}
        >
          <MDEditor.Markdown
            source={draft.contentMd}
            {...katexPlugins}
            style={{ background: 'transparent', fontSize: tokens.fontSize.xl }}
          />
        </div>
      ) : (
        <div style={{ ...borderStyle, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* 常驻格式工具条（M1）：选中时高亮当前格式，点击即包裹选区 / 切换行前缀 */}
          {access.canEdit && (
            <div style={{ padding: `0 ${tokens.spacing.sm}px` }}>
              <MarkdownToolbar view={view} />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            {/* 右键插入菜单（M1）：表格 / 公式 / 图片 / 代码块 / 引用 / 分割线 */}
            <Dropdown
              menu={{ items: insertMenuItems, onClick: onInsertMenuClick }}
              trigger={['contextMenu']}
              disabled={!access.canEdit}
            >
              <div
                style={{ height: '100%' }}
                onContextMenu={(e) => {
                  // CM6 只在左键移动光标；右键插入要落在「点击位置」而非旧光标处。
                  // 若点击落在已有选区内则保留选区（VS Code 行为），避免右键把选区折叠掉。
                  const target = viewRef.current
                  if (!target) return
                  const pos = target.posAtCoords({ x: e.clientX, y: e.clientY })
                  if (pos == null) return
                  const insideSelection = target.state.selection.ranges.some(
                    (r) => !r.empty && pos >= r.from && pos <= r.to,
                  )
                  if (!insideSelection) target.dispatch({ selection: EditorSelection.cursor(pos) })
                }}
              >
                {/* key=pageId：切页即重建编辑器实例，避免 CM6 的撤销栈跨页（否则 Ctrl+Z 会把上一页全文写进当前页） */}
                <MarkdownSourceEditor
                  key={draft.pageId}
                  value={draft.contentMd}
                  readOnly={!access.canEdit}
                  onChange={onEditorChange}
                  onViewReady={onViewReady}
                />
              </div>
            </Dropdown>
          </div>
        </div>
      )}
    </Panel>
  )
}
