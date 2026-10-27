import { useEffect, useRef, useState } from 'react'
import {
  Alert,
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
  type MenuProps,
} from '../ui'
import { PlusOutlined, RobotOutlined, SendOutlined, UserOutlined } from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useAiStore, type ChatMessage } from '../../stores/aiStore'
import { useUnsavedGuard } from './useUnsavedGuard'
import { tokens } from '../../theme/tokens'

const katexPlugins = {
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
}

/** 默认头像占位（后续可替换为课程/用户自定义头像） */
const AI_AVATAR = <RobotOutlined />
const USER_AVATAR = <UserOutlined />

/**
 * 动态状态徽章（§4.3.1，2026-10-20）：测试所选 Release == 上线版本 → Live，否则 Testing。
 * 浅绿底 + 绿点 + 绿字（与顶部栏原静态 Testing 徽章同风格）。
 */
function StateBadge({ live }: { live: boolean }) {
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
      {live ? 'Live' : 'Testing'}
    </span>
  )
}

/**
 * 知识库 Release 选择器（§4.3.1，2026-10-20）：
 * versionTag（蓝色可点击）→ 展开按发布倒序的 Release 下拉（上线行带 Live 徽章、当前项高亮）；
 * 右侧动态徽章 + Set Live 按钮。切换时若有未保存改动 → 弹未保存提醒（保存 / 取消；§4.3.6）。
 */
function ReleaseSelector() {
  const config = useAiStore((s) => s.config)
  const releases = useAiStore((s) => s.releases)
  const selectRelease = useAiStore((s) => s.selectRelease)
  const setLive = useAiStore((s) => s.setLive)
  const guard = useUnsavedGuard()

  const currentId = config?.releaseId ?? null
  const live = config?.isLive ?? false

  const pick = async (releaseId: string) => {
    if (releaseId === currentId) return
    if (!(await guard())) return
    await selectRelease(releaseId)
  }

  const items: MenuProps['items'] = releases.length
    ? releases.map((r) => ({
        key: r.id,
        label: (
          <Space size="small">
            <span>{r.versionTag}</span>
            {r.isActive && <Tag color="green">Live</Tag>}
          </Space>
        ),
      }))
    : [{ key: '__none', label: '暂无 Release', disabled: true }]

  return (
    <Space size="small">
      <Dropdown
        trigger={['click']}
        disabled={!releases.length}
        menu={{
          items,
          selectedKeys: currentId ? [currentId] : [],
          onClick: ({ key }) => {
            if (key !== '__none') void pick(key)
          },
        }}
      >
        <span
          style={{
            color: tokens.color.primary,
            cursor: releases.length ? 'pointer' : 'default',
            fontSize: tokens.fontSize.xl,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {config?.releaseTag ?? '未发布'}
        </span>
      </Dropdown>
      <StateBadge live={live} />
      <Button
        type="primary"
        disabled={!currentId || live}
        onClick={() => void setLive()}
      >
        Set Live
      </Button>
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
            options={[
              { label: 'Lecture', value: 'LECTURE' },
              { label: 'Socratic', value: 'SOCRATIC' },
            ]}
          />
          {/* 右侧：New Chat（主色实心主按钮 + 前置 "+" 图标，2026-10-20 按参考图调整） */}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            style={{ fontWeight: tokens.fontWeight.semibold }}
            onClick={newChat}
          >
            New Chat
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
          <Empty description={selectedCourseId ? '开始对话吧' : '请先在顶部选择课程'} />
        ) : (
          messages.map((m, i) => <Bubble key={`${m.createdAt}-${i}`} msg={m} />)
        )}
      </div>
      <Space.Compact style={{ marginTop: tokens.spacing.md, width: '100%' }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder={selectedCourseId ? 'Ask the tutor a question...' : '请先选择课程'}
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
          Send
        </Button>
      </Space.Compact>
    </Card>
  )
}
