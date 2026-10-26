import { Layout } from '../ui'
import { tokens } from '../../theme/tokens'

const { Sider, Content } = Layout

interface MainLayoutProps {
  /** 左侧课程树列；仅 Knowledge 模块传入 */
  sidebar?: React.ReactNode
  /** 顶部整宽 Tab 栏（横跨课程树列 + 内容区，位于同步目标上方）（2026-10-19） */
  topBar?: React.ReactNode
  children: React.ReactNode
}

/**
 * Knowledge / AI Tutor 工作区布局（对齐 Figma 设计库）：
 * 顶部栏与左侧菜单由 BackOffice 外壳（backoffice/components/AppShell）统一提供，
 * 这里只负责外壳内容区：（可选）整宽 Tab 栏 + 课程树列 + 内容区。
 * topBar 横跨「课程树列 + 内容区」并位于课程树列上方（对齐 Figma 帧 1.1 Page Editor 665:543）。
 * 内容区与课程树列均为页面灰底 `#F8FAFC` 上的白色圆角卡片（`ui/Panel`，2026-10-19 卡片化）。
 */
export function MainLayout({ sidebar, topBar, children }: MainLayoutProps) {
  return (
    <Layout style={{ flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {topBar}
      <Layout style={{ flexDirection: 'row', flex: 1, minHeight: 0 }}>
        {sidebar && (
          <Sider
            width={300}
            theme="light"
            style={{
              // 侧栏卡片化（2026-10-19）：页面灰底并留出内边距，内部课程树列以白色圆角卡片悬浮
              overflow: 'visible',
              background: tokens.color.bg.layout,
              padding: tokens.spacing.lg,
            }}
          >
            {sidebar}
          </Sider>
        )}
        <Content
          style={{
            padding: tokens.spacing.lg,
            overflow: 'hidden',
            background: tokens.color.bg.layout,
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  )
}
