import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  type MenuProps,
} from '../ui'
import { PlusOutlined, RobotOutlined, SendOutlined, UserOutlined } from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useAiStore, type ChatMessage } from '../../stores/aiStore'
import { useUnsavedGuard } from './useUnsavedGuard'
import { useAiText } from './i18n'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

const katexPlugins = {
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
}

/** 默认头像占位（后续可替换为课程/用户自定义头像） */
const AI_AVATAR = <RobotOutlined />
const USER_AVATAR = <UserOutlined />

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
  const guard = useUnsavedGuard()

  const currentId = config?.releaseId ?? null
  const live = config?.isLive ?? false
  // 流式回答进行中不切换版本（QA 2026-10-27 A13）
  const canSwitch = access.canPublish && releases.length > 0 && !streaming

  const pick = async (releaseId: string) => {
    if (releaseId === currentId) return
    if (!(await guard())) return
    try {
      await selectRelease(releaseId)
    } catch (e) {
      message.error((e as Error).message || text('releaseSwitchFailed'))
    }
  }

  const onSetLive = async () => {
    try {
      await setLive()
      message.success(text('setLiveDone', { version: config?.releaseTag ?? '' }))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 单一决策变量：是否启用滚动窗口（§4.3.1，2026-10-28；经验：条件收敛） */
  const canScroll = releases.length > MAX_VISIBLE_RELEASES

  const items: MenuProps['items'] = releases.length
    ? releases.map((r) => {
        /** 第二行版本说明：revisionNotes 为空 → 占位；单行截断 + tooltip（设计文档拍板） */
        const hasNotes = Boolean(r.revisionNotes?.trim())
        const noteDisplay = hasNotes ? r.revisionNotes : text('noRevisionNotes')
        const noteColor = hasNotes ? tokens.color.text.secondary : tokens.color.text.tertiary
        return {
          key: r.id,
          label: (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: tokens.spacing.xs,
                minWidth: 220,
                padding: `${tokens.spacing.xs}px 0`,
              }}
            >
              {/* 第一行：versionTag + Live 徽章 */}
              <Space size="small">
                <span>{r.versionTag}</span>
                {r.isActive && <Tag color="green">{text('live')}</Tag>}
              </Space>
              {/* 第二行：版本说明（单行截断 + tooltip） */}
              <Tooltip title={hasNotes ? r.revisionNotes : undefined}>
                <span
                  style={{
                    display: 'block',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: tokens.fontSize.md,
                    color: noteColor,
                    lineHeight: 1.4,
                  }}
                >
                  {noteDisplay}
                </span>
              </Tooltip>
            </div>
          ),
        }
      })
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
          disabled={!currentId || live || streaming}
          onClick={() => void onSetLive()}
        >
          {text('setLive')}
        </Button>
      )}
    </Space>
  )
}

/** 单条消息气泡：带头像，AI 左侧灰底，用户右侧蓝底（§4.3.5） */
function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isUser ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
        gap: tokens.spacing.sm,
      }}
    >
      <Avatar
        icon={isUser ? USER_AVATAR : AI_AVATAR}
        style={{
          backgroundColor: isUser ? tokens.color.primary : tokens.color.success,
          flexShrink: 0,
        }}
      />
      <div
        style={{
          maxWidth: '75%',
          background: isUser ? tokens.color.primary : tokens.color.bg.layout,
          color: isUser ? tokens.color.bg.container : 'inherit',
          padding: `${tokens.spacing.sm}px ${tokens.spacing.md}px`,
          borderRadius: tokens.radius.md,
          whiteSpace: isUser ? 'pre-wrap' : 'normal',
        }}
      >
        {msg.content ? (
          <div data-color-mode="light" className={isUser ? 'chat-bubble-user' : undefined}>
            <MDEditor.Markdown
              source={msg.content}
              {...katexPlugins}
              style={{ background: 'transparent', fontSize: tokens.fontSize.xl }}
            />
          </div>
        ) : (
          <Spin size="small" />
        )}
      </div>
    </div>
  )
}

/**
 * AI Tutor 右侧对话面板（§4.3）：模式切换 / New Chat / 流式消息列表 / 输入框。
 */
export function ChatWindow() {
  const mode = useAiStore((s) => s.mode)
  const messages = useAiStore((s) => s.messages)
  const streaming = useAiStore((s) => s.streaming)
  const error = useAiStore((s) => s.error)
  const selectedCourseId = useAiStore((s) => s.selectedCourseId)
  const setMode = useAiStore((s) => s.setMode)
  const newChat = useAiStore((s) => s.newChat)
  const send = useAiStore((s) => s.send)
  const { text, modeLabel } = useAiText()

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // 流式增量时保持滚动到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const onSend = async () => {
    const text = input
    setInput('')
    await send(text)
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
            className="ai-mode-segmented"
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
            onClick={newChat}
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
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing.md,
          padding: `${tokens.spacing.xs}px 0`,
        }}
      >
        {messages.length === 0 ? (
          <Empty description={selectedCourseId ? text('emptyChat') : text('pickCourseFirst')} />
        ) : (
          messages.map((m, i) => <Bubble key={`${m.createdAt}-${i}`} msg={m} />)
        )}
      </div>
      <Space.Compact style={{ marginTop: tokens.spacing.md, width: '100%' }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder={selectedCourseId ? text('inputPlaceholder') : text('inputNoCourse')}
          disabled={!selectedCourseId || streaming}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              void onSend()
            }
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={streaming}
          disabled={!selectedCourseId || !input.trim()}
          onClick={() => void onSend()}
        >
          {text('send')}
        </Button>
      </Space.Compact>
    </Card>
  )
}
