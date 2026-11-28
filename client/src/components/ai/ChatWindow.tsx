import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  Segmented,
  Space,
  Spin,
  Tooltip,
  type MenuProps,
} from '../ui'
import { CopyOutlined, PlusOutlined, ReloadOutlined, SendOutlined, UndoOutlined } from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { ChatAnswer } from './ChatAnswer'
import { normalizeTutorMarkdown } from './normalizeTutorMarkdown'
import { safeMarkdownPlugins } from './safeMarkdownPlugins'
import { tutorAnswerPlainText } from './chatAnswerParts'
import { useAiStore, type ChatMessage } from '../../stores/aiStore'
import { useUnsavedGuard } from './useUnsavedGuard'
import { useAiText } from './i18n'
import { copyToClipboard, stripMarkdown } from './chatUtils'
import { useLocale } from '../../backoffice/lib/navigation'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccessState'
import { tokens } from '../../theme/tokens'
import { AiReleaseOption } from './AiReleaseOption'
import './chatWindow.css'

const userMarkdownPlugins = {
  remarkPlugins: [remarkGfm, remarkMath],
  rehypePlugins: [rehypeKatex],
  pluginsFilter: safeMarkdownPlugins,
}

/** Release 下拉最多展示几项后启用滚动窗口（§4.3.1，2026-10-28 新增） */
const MAX_VISIBLE_RELEASES = 5
/** 滚动窗口 max-height：约容纳 5 个双行项（2026-10-28 新增） */
const MAX_DROPDOWN_HEIGHT = 300

/**
 * 动态状态徽章（§4.3.1，2026-10-20）：测试所选 Release == 上线版本 → Live，否则 Testing。
 * 浅绿底 + 绿点 + 绿字（与顶部栏原静态 Testing 徽章同风格）。
 */
function StateBadge({ live }: { live: boolean }) {
  const { text } = useAiText()
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        background: '#ECFDF3',
        color: tokens.color.success,
        fontSize: tokens.fontSize.md,
        fontWeight: tokens.fontWeight.semibold,
        lineHeight: '18px',
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: tokens.color.success }}
      />
      {live ? text('live') : text('testing')}
    </span>
  )
}

/**
 * 知识库 Release 选择器（§4.3.1，2026-10-20）：
 * versionTag（蓝色可点击）→ 展开按发布倒序的 Release 下拉（上线行带 Live 徽章、当前项高亮）；
 * 右侧动态徽章 + Set Live 按钮。切换时若有未保存改动 → 弹未保存提醒（保存 / 取消；§4.3.6）。
 */
function ReleaseSelector() {
  const { message } = App.useApp()
  const { text } = useAiText()
  /** 切换测试版本与 Set Live 在服务端都是 PUBLISH：无发布权限的角色只看不点（QA 2026-10-27 A8） */
  const access = useWorkspaceAccess()
  const config = useAiStore((s) => s.config)
  const releases = useAiStore((s) => s.releases)
  const streaming = useAiStore((s) => s.streaming)
  const selectRelease = useAiStore((s) => s.selectRelease)
  const setLive = useAiStore((s) => s.setLive)
  const pending = useAiStore((s) => s.selectedCourseId ? Boolean(s.pendingCourseActions[s.selectedCourseId]) : false)
  const picking = useRef(false)
  const guard = useUnsavedGuard()

  const currentId = config?.releaseId ?? null
  const live = config?.isLive ?? false
  // 流式回答进行中不切换版本（QA 2026-10-27 A13）
  const canSwitch = access.canPublish && releases.length > 0 && !streaming && !pending

  const pick = async (releaseId: string) => {
    if (releaseId === currentId || pending || picking.current) return
    picking.current = true
    try {
      if (!(await guard())) return
      await selectRelease(releaseId)
    } catch (e) {
      message.error((e as Error).message || text('releaseSwitchFailed'))
    } finally {
      picking.current = false
    }
  }

  const onSetLive = async () => {
    try {
      if (await setLive()) message.success(text('setLiveDone', { version: config?.releaseTag ?? '' }))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 单一决策变量：是否启用滚动窗口（§4.3.1，2026-10-28；经验：条件收敛） */
  const canScroll = releases.length > MAX_VISIBLE_RELEASES

  const items: MenuProps['items'] = releases.length
    ? releases.map((release) => ({ key: release.id, label: <AiReleaseOption release={release} /> }))
    : [{ key: '__none', label: text('noReleases'), disabled: true }]

  return (
    <Space size="small">
      <Dropdown
        trigger={['click']}
        disabled={!canSwitch}
        menu={{
          items,
          selectedKeys: currentId ? [currentId] : [],
          onClick: ({ key }) => {
            if (key !== '__none') void pick(key)
          },
          // 条件滚动：>5 项才启 max-height（§4.3.1，2026-10-28）
          style: canScroll ? { maxHeight: MAX_DROPDOWN_HEIGHT, overflowY: 'auto' } : undefined,
        }}
      >
        <span
          style={{
            color: tokens.color.primary,
            cursor: canSwitch ? 'pointer' : 'default',
            fontSize: tokens.fontSize.xl,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {config?.releaseTag ?? text('unpublished')}
        </span>
      </Dropdown>
      <StateBadge live={live} />
      {access.canPublish && (
        <Button
          type="primary"
          disabled={!currentId || live || streaming || pending}
          onClick={() => void onSetLive()}
        >
          {text('setLive')}
        </Button>
      )}
    </Space>
  )
}

/** 单条消息气泡 + 工具栏（§4.3.5，2026-10-30：加复制/撤回/刷新） */
function Bubble({
  msg,
  isLastUser,
  streaming,
  onCopyPlain,
  onCopyMarkdown,
  onRetry,
  onUndo,
  text,
  courseId,
  timeFormat,
}: {
  msg: ChatMessage
  /** 是否为最后一条 user 消息（决定刷新/撤回按钮是否启用） */
  isLastUser: boolean
  streaming: boolean
  onCopyPlain: () => Promise<void>
  onCopyMarkdown: () => Promise<void>
  onRetry: () => Promise<void>
  onUndo: () => void
  text: (key: string) => string
  courseId: string | null
  timeFormat: Intl.DateTimeFormat
}) {
  const isUser = msg.role === 'user'
  const hasContent = Boolean(msg.content?.trim())
  const timestamp = Date.parse(msg.createdAt)

  return (
    <div className={isUser ? 'tutor-message-row user' : 'tutor-message-row assistant'}>
      <div className="tutor-message-line">
        <div className="tutor-message-bubble-wrap">
          <span className="tutor-avatar" aria-hidden="true">{isUser ? text('userAvatar') : 'AI'}</span>
          <div className="tutor-message">
            {hasContent ? (
              isUser ? (
                <div data-color-mode="light" className="chat-bubble-user">
                  <MDEditor.Markdown
                    source={normalizeTutorMarkdown(msg.content)}
                    {...userMarkdownPlugins}
                    style={{ background: 'transparent', fontSize: tokens.fontSize.xl }}
                  />
                </div>
              ) : <ChatAnswer content={msg.content} courseId={courseId} sourcesLabel={text('sources')} />
            ) : msg.status !== 'error' && msg.status !== 'aborted' ? <Spin size="small" /> : null}
            {(msg.status === 'error' || msg.status === 'aborted') &&
              <div role="status">{text(msg.status === 'aborted' ? 'aborted' : 'incomplete')}</div>}
          </div>
          {Number.isFinite(timestamp) && <time className="tutor-message-time" dateTime={msg.createdAt}>{timeFormat.format(timestamp)}</time>}
        </div>
      </div>

      <div className="tutor-message-actions">
        {!isUser ? (
          // AI 工具栏：复制（Dropdown：纯文本 / Markdown）
          <Dropdown
            placement="topLeft"
            menu={{
              items: [
                { key: 'plain', icon: <CopyOutlined />, label: text('copyPlain'), onClick: () => void onCopyPlain() },
                { key: 'md', icon: <CopyOutlined />, label: text('copyMarkdown'), onClick: () => void onCopyMarkdown() },
              ],
            }}
            trigger={['click']}
          >
            <Tooltip title={text('copy')}>
              <Button type="text" size="small" aria-label={text('copy')} icon={<CopyOutlined />} disabled={!hasContent} />
            </Tooltip>
          </Dropdown>
        ) : (
          // User 工具栏：复制 + 刷新 + 撤回
          <>
            <Tooltip title={text('copy')}>
              <Button
                type="text"
                size="small"
                aria-label={text('copy')}
                icon={<CopyOutlined />}
                disabled={!hasContent}
                onClick={() => void onCopyMarkdown()}
              />
            </Tooltip>
            <Tooltip title={text('retry')}>
              <Button
                type="text"
                size="small"
                aria-label={text('retry')}
                icon={<ReloadOutlined />}
                disabled={!isLastUser || streaming}
                onClick={() => void onRetry()}
              />
            </Tooltip>
            <Tooltip title={text('undo')}>
              <Button
                type="text"
                size="small"
                aria-label={text('undo')}
                icon={<UndoOutlined />}
                disabled={!isLastUser || streaming}
                onClick={onUndo}
              />
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * AI Tutor 右侧对话面板（§4.3）：模式切换 / New Chat / 流式消息列表 / 输入框。
 */
export function ChatWindow() {
  const { message, modal } = App.useApp()
  const saving = useAiStore((s) => s.saving)
  const mode = useAiStore((s) => s.mode)
  const messages = useAiStore((s) => s.messages)
  const streaming = useAiStore((s) => s.streaming)
  const error = useAiStore((s) => s.error)
  const config = useAiStore((s) => s.config)
  const selectedCourseId = useAiStore((s) => s.selectedCourseId)
  const setMode = useAiStore((s) => s.setMode)
  const newChat = useAiStore((s) => s.newChat)
  const send = useAiStore((s) => s.send)
  const cancel = useAiStore((s) => s.cancel)
  const retryLastUserMessage = useAiStore((s) => s.retryLastUserMessage)
  const undoLastUserMessage = useAiStore((s) => s.undoLastUserMessage)
  const { text, modeLabel } = useAiText()
  const locale = useLocale()
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }), [locale])

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const sendDisabled = saving || !selectedCourseId || (!streaming && !input.trim())

  // 流式增量时保持滚动到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const onSend = async () => {
    const t = input
    if (!t.trim()) return
    // 2026-10-29：没有可用版本（releaseId 为 null）时禁止发送
    if (!config?.releaseId) {
      message.warning(text('chatNoRelease'))
      return
    }
    setInput('')
    await send(t)
  }

  /**
   * 切换对话模式（2026-10-27）：只切换提示词注入，不重置当前聊天会话，
   * 也不触碰左侧配置表单（无需未保存提醒）。
   */
  const onModeChange = (v: string) => {
    setMode(v as 'LECTURE' | 'SOCRATIC')
  }

  return (
    <Card
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title={
        <Space size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
          {/* 左侧：知识库 Release 选择器 + 动态徽章 + Set Live（§4.3.1） */}
          <ReleaseSelector />
          {/* 中间：模式切换（蓝色高亮选中项） */}
          <Segmented
            className="ai-segmented"
            value={mode}
            onChange={(v) => onModeChange(v as string)}
            options={(['LECTURE', 'SOCRATIC'] as const).map((m) => ({
              label: modeLabel(m),
              value: m,
            }))}
          />
          {/* 右侧：New Chat（主色实心主按钮 + 前置 "+" 图标，2026-10-20 按参考图调整） */}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            style={{ fontWeight: tokens.fontWeight.semibold }}
            disabled={streaming}
            onClick={() => {
              // 2026-10-29：没有可用版本时禁止 New Chat
              if (!config?.releaseId) {
                message.warning(text('chatNoRelease'))
                return
              }
              newChat()
            }}
          >
            {text('newChat')}
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          style={{ marginBottom: tokens.spacing.sm }}
        />
      )}
      <div
        ref={listRef}
        className="ai-test-messages"
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 17,
          padding: `${tokens.spacing.xs}px 0`,
        }}
      >
        {messages.length === 0 ? (
          <Empty description={selectedCourseId ? text('emptyChat') : text('pickCourseFirst')} />
        ) : (
          messages.map((m, i) => {
            // 计算该消息是否为「最后一条 user 消息」——刷新/撤回按钮只对这个启用
            const isLastUser = m.role === 'user' && messages.slice(i + 1).every((n) => n.role !== 'user')
            return (
              <Bubble
                key={`${m.createdAt}-${i}`}
                msg={m}
                isLastUser={isLastUser}
                streaming={streaming}
                text={text}
                courseId={selectedCourseId}
                timeFormat={timeFormat}
                onCopyPlain={async () => {
                  const plain = m.role === 'user'
                    ? stripMarkdown(m.content)
                    : tutorAnswerPlainText(m.content, text('sources'))
                  const ok = await copyToClipboard(plain)
                  message[ok ? 'success' : 'error'](ok ? text('copied') : text('copyFailed'))
                }}
                onCopyMarkdown={async () => {
                  const ok = await copyToClipboard(m.content)
                  message[ok ? 'success' : 'error'](ok ? text('copied') : text('copyFailed'))
                }}
                onRetry={async () => {
                  const ok = await retryLastUserMessage()
                  if (!ok) message.error(text('retryFailed'))
                }}
                onUndo={() => {
                  modal.confirm({
                    title: text('undoConfirmTitle'),
                    content: text('undoConfirmContent'),
                    okText: text('undoConfirmOk'),
                    cancelText: text('cancel'),
                    okButtonProps: { danger: true },
                    onOk: () => {
                      undoLastUserMessage()
                      setInput(m.content)
                      message.success(text('undoDone'))
                    },
                  })
                }}
              />
            )
          })
        )}
      </div>
      <div className="ai-test-composer" style={{ marginTop: tokens.spacing.md }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder={selectedCourseId ? text('inputPlaceholder') : text('inputNoCourse')}
          disabled={!selectedCourseId || streaming}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
            e.preventDefault()
            if (!sendDisabled) void onSend()
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          disabled={sendDisabled}
          onClick={() => streaming ? cancel() : void onSend()}
        >
          {text(streaming ? 'stop' : 'send')}
        </Button>
      </div>
    </Card>
  )
}
