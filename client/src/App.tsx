import { useState } from 'react'
import { App as AntApp, ConfigProvider } from 'antd'
import enGB from 'antd/locale/en_GB'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { MainLayout } from './components/layout/MainLayout'
import { Sidebar } from './components/layout/Sidebar'
import {
  KnowledgeTabBar,
  type KnowledgeTabKey,
} from './components/knowledge/KnowledgeTabBar'
import { KnowledgeSystem } from './pages/KnowledgeSystem'
import { AITutor, AITutorTopBar } from './pages/AITutor'
import { tokens } from './theme/tokens'
import { ShellRoute } from './backoffice/ShellRoute'
import ActivatePage from './backoffice/pages/ActivatePage'
import ForgotPasswordPage from './backoffice/pages/ForgotPasswordPage'
import ResetPasswordPage from './backoffice/pages/ResetPasswordPage'
import SignInPage from './backoffice/pages/SignInPage'
import {
  CoursePage,
  EmployeeAccountSettingsPage,
  MenuGuard,
  PlaceholderPage,
  SettingsEntryPage,
  SettingsIndexPage,
} from './backoffice/pages/ModulePages'
import { DEFAULT_LOCALE, isLocale } from './backoffice/lib/i18n/config'
import { DEFAULT_LANDING_MENU, menuHref } from './backoffice/rbac/permissions'

/**
 * 全局主题（对齐 Figma 设计库 2026-10-16；内容面板统一 2026-10-19）：
 * 将设计 token 注入 Ant Design ConfigProvider，使 antd 组件（按钮/输入框/标签等）
 * 自动使用 Figma 配色（主色 #1D6BFF、边框 #E8EDF5、基础圆角 8px）。
 * `borderRadiusLG=12`：Card/Modal 等大容器圆角对齐 Figma 主内容面板（12px）。
 * `components.Input/Select`：输入类描边 #E2E8F0、底色 #FAFBFC，对齐 Figma 输入控件规格。
 */
const themeConfig = {
  token: {
    colorPrimary: tokens.color.primary,
    colorSuccess: tokens.color.success,
    colorWarning: tokens.color.warning,
    colorError: tokens.color.error,
    colorBorder: tokens.color.border,
    colorBorderSecondary: tokens.color.border,
    borderRadius: tokens.radius.md,
    borderRadiusLG: tokens.radius.lg,
    fontSize: tokens.fontSize.xl,
  },
  components: {
    // 输入类（输入框 / 文本域）：描边 #E2E8F0、底色 #FAFBFC（Figma 输入控件规格）
    Input: {
      colorBorder: tokens.color.inputBorder,
      colorBgContainer: tokens.color.inputBg,
    },
    // 下拉选择（输入类同类控件）：同样对齐 Figma 描边与底色
    Select: {
      colorBorder: tokens.color.inputBorder,
      colorBgContainer: tokens.color.inputBg,
    },
  },
}

/** Knowledge 工作区：整宽 Tab 栏；课程树仅在 "Knowledge Pages" Tab 显示 */
function KnowledgeWorkspace() {
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTabKey>('pages')
  return (
    <MainLayout
      topBar={<KnowledgeTabBar active={knowledgeTab} onChange={setKnowledgeTab} />}
      sidebar={knowledgeTab === 'pages' ? <Sidebar /> : undefined}
    >
      <KnowledgeSystem tab={knowledgeTab} />
    </MainLayout>
  )
}

/** AI Tutor 工作区：与 Knowledge 展示方式一致的课程标题栏（2026-10-20） */
function AITutorWorkspace() {
  return (
    <MainLayout topBar={<AITutorTopBar />}>
      <AITutor />
    </MainLayout>
  )
}

/** antd 内置文案跟随地址栏语言（/en-GB/... 或 /zh-CN/...） */
function useAntdLocale() {
  const segment = useLocation().pathname.split('/')[1]
  return segment === 'zh-CN' ? zhCN : enGB
}

const LANDING = menuHref(DEFAULT_LOCALE, DEFAULT_LANDING_MENU)

/** 未带语言前缀的地址补上默认语言 */
function LocaleFallback() {
  const { pathname, search } = useLocation()
  const [, first] = pathname.split('/')
  if (isLocale(first)) return <Navigate to={`/${first}/course`} replace />
  return <Navigate to={pathname === '/' ? LANDING : `/${DEFAULT_LOCALE}${pathname}${search}`} replace />
}

function App() {
  return (
    <ConfigProvider locale={useAntdLocale()} theme={themeConfig}>
      {/* App 包裹层：提供 message/modal 上下文（§3.2.2 全量同步警告弹框等） */}
      <AntApp>
        <Routes>
          <Route path="/:locale/sign-in" element={<SignInPage />} />
          <Route path="/:locale/activate" element={<ActivatePage />} />
          <Route path="/:locale/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/:locale/reset-password" element={<ResetPasswordPage />} />
          <Route path="/:locale" element={<ShellRoute />}>
            <Route index element={<Navigate to="course" replace />} />
            <Route path="course" element={<CoursePage />} />
            <Route
              path="knowledge"
              element={
                <MenuGuard menu="knowledge">
                  <KnowledgeWorkspace />
                </MenuGuard>
              }
            />
            <Route
              path="ai-tutor"
              element={
                <MenuGuard menu="aiTutor">
                  <AITutorWorkspace />
                </MenuGuard>
              }
            />
            <Route path="order" element={<PlaceholderPage menu="order" />} />
            <Route path="reporting" element={<PlaceholderPage menu="reporting" />} />
            <Route path="student" element={<PlaceholderPage menu="student" />} />
            <Route path="help-desk" element={<PlaceholderPage menu="helpDesk" />} />
            <Route path="settings" element={<SettingsIndexPage />} />
            <Route path="settings/employee-account" element={<EmployeeAccountSettingsPage />} />
            <Route path="settings/payment-gateway" element={<SettingsEntryPage section="paymentGateway" />} />
            <Route
              path="settings/notification-configuration"
              element={<SettingsEntryPage section="notificationConfiguration" />}
            />
          </Route>
          <Route path="*" element={<LocaleFallback />} />
        </Routes>
      </AntApp>
    </ConfigProvider>
  )
}

export default App
