import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'

/** Knowledge 模块顶部 Tab 键 */
export type KnowledgeTabKey = 'pages' | 'publish'

interface KnowledgeTabBarProps {
  active: KnowledgeTabKey
  onChange: (key: KnowledgeTabKey) => void
}

const TABS: { key: KnowledgeTabKey; labelKey: string }[] = [
  { key: 'pages', labelKey: 'tabs.pages' },
  { key: 'publish', labelKey: 'tabs.publish' },
]

/**
 * Knowledge 顶部整宽 Tab 栏（2026-10-19 新增，对齐 Figma 帧 `1.1 Page Editor` 665:543）。
 * 横跨「课程树列 + 内容区」，位于同步目标列上方。
 * 样式对齐 Figma：白底 + 1px 底边线；激活态主色 #145CFF / 非激活 #000 / 字号 16 / 字重 600，
 * 激活 Tab 底部 2px 主色下划线（下划线宽度 = 文字宽度）。
 */
export function KnowledgeTabBar({ active, onChange }: KnowledgeTabBarProps) {
  const { text } = useKText()
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing['2xl'],
        height: 63,
        padding: `0 ${tokens.spacing.xl}px`,
        background: tokens.color.bg.container,
        borderBottom: `1px solid ${tokens.color.border}`,
        flexShrink: 0,
      }}
    >
      {TABS.map((tab) => {
        const on = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.key)}
            style={{
              position: 'relative',
              height: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              fontSize: tokens.fontSize['2xl'],
              fontWeight: tokens.fontWeight.semibold,
              color: on ? tokens.color.primaryDark : '#000000',
            }}
          >
            {text(tab.labelKey)}
            {on && (
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
            )}
          </button>
        )
      })}
    </div>
  )
}
