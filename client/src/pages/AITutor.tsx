import { useEffect } from 'react'
import { ConfigPanel } from '../components/ai/ConfigPanel'
import { ChatWindow } from '../components/ai/ChatWindow'
import { TutorManagerModal } from '../components/ai/TutorManagerModal'
import { useAiStore } from '../stores/aiStore'
import { useAiText } from '../components/ai/i18n'
import { tokens } from '../theme/tokens'

/**
 * AI Tutor 顶部栏（§4.1，2026-10-20）：
 * 展示方式与 Knowledge 顶部 Tab 栏（`KnowledgeTabBar`）保持一致——全宽白色栏、
 * 高 63px、底部 1px 分隔线；标题文字主色 `#145CFF`、16px、字重 600、底部 2px 下划线。
 * 2026-10-20 对调：顶部栏标题由「当前 Course 名」改为模块名「AI Tutor」，
 * Course 名移至配置卡标题行（见 `ConfigPanel`）。
 * 2026-10-20：原右侧静态 Testing 徽章移除（改挂对话头部 versionTag 旁，见 `ChatWindow`）。
 * 经 `MainLayout` 的 `topBar` 槽位注入。
 */
export function AITutorTopBar() {
  const { text } = useAiText()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing.md,
        height: 63,
        padding: `0 ${tokens.spacing.xl}px`,
        background: tokens.color.bg.container,
        borderBottom: `1px solid ${tokens.color.border}`,
        flexShrink: 0,
      }}
    >
      {/* 模块标题：对齐 KnowledgeTabBar 激活态（主色 #145CFF / 16px / 600 / 底部 2px 下划线） */}
      <span
        style={{
          position: 'relative',
          height: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: tokens.fontSize['2xl'],
          fontWeight: tokens.fontWeight.semibold,
          color: tokens.color.primaryDark,
        }}
      >
        {text('title')}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            background: tokens.color.primaryDark,
          }}
        />
      </span>
    </div>
  )
}

/**
 * AI Tutor 页面（§4.1）：
 * 顶部模块标题栏经 `topBar` 注入（见 `AITutorTopBar`）；
 * 页面主体为左侧配置面板 + 右侧对话窗口。
 * 左右分栏比例（2026-10-20 改拍）：配置面板 40%、对话窗口 60%。
 */
export function AITutor() {
  const init = useAiStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div style={{ height: '100%', display: 'flex', gap: tokens.spacing.md }}>
      <div style={{ flex: '0 0 40%', minWidth: 0 }}>
        <ConfigPanel />
      </div>
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <ChatWindow />
      </div>
      <TutorManagerModal />
    </div>
  )
}
