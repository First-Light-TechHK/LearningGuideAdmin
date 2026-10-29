import { useState } from 'react'
import { App as AntApp, ConfigProvider } from 'antd'
import enGB from 'antd/locale/en_GB'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { MainLayout } from './components/layout/MainLayout'
import { Sidebar } from './components/layout/Sidebar'
import { KnowledgeTabBar, type KnowledgeTabKey } from './components/knowledge/KnowledgeTabBar'
import { KnowledgeSystem } from './pages/KnowledgeSystem'
import { AITutor, AITutorTopBar } from './pages/AITutor'
import { tokens } from './theme/tokens'
import { ShellRoute } from './backoffice/ShellRoute'
import ActivatePage from './backoffice/pages/ActivatePage'
import ForgotPasswordPage from './backoffice/pages/ForgotPasswordPage'
import ResetPasswordPage from './backoffice/pages/ResetPasswordPage'
import SignInPage from './backoffice/pages/SignInPage'
import HelpDeskPage from './backoffice/pages/HelpDeskPage'
import {
  EmployeeAccountSettingsPage,
  MenuGuard,
  PlaceholderPage,
  SettingsEntryPage,
  SettingsIndexPage,
} from './backoffice/pages/ModulePages'
import { CourseManagementPage } from './backoffice/pages/CourseManagementPage'
import { CourseEditorPage } from './backoffice/pages/CourseEditorPage'
import { CoursePreviewPage } from './backoffice/pages/CoursePreviewPage'
import { DEFAULT_LOCALE, isLocale } from './backoffice/lib/i18n/config'
import { WorkspaceAccessProvider } from './backoffice/lib/workspaceAccess'
import { DEFAULT_LANDING_MENU, menuHref } from './backoffice/rbac/permissions'
import { ErrorBoundary } from './components/ErrorBoundary'

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

/** 第一段不是语言（如旧书签 /knowledge）时补上默认语言，否则会被当成语言参数 */
function LocaleGate() {
  const { locale } = useParams<{ locale: string }>()
  const { pathname, search } = useLocation()
  if (isLocale(locale)) return <Outlet />
  return <Navigate to={`/${DEFAULT_LOCALE}${pathname}${search}`} replace />
}

/** 未带语言前缀的地址补上默认语言 */
function LocaleFallback() {
  const { pathname, search } = useLocation()
  const [, first] = pathname.split('/')
  if (isLocale(first)) return <Navigate to={`/${first}/course`} replace />
  return (
    <Navigate to={pathname === '/' ? LANDING : `/${DEFAULT_LOCALE}${pathname}${search}`} replace />
  )
}

function App() {
  return (
    <ConfigProvider locale={useAntdLocale()} theme={themeConfig}>
      {/* App 包裹层：提供 message/modal 上下文（§3.2.2 全量同步警告弹框等） */}
      <AntApp>
        {/* 全局错误边界：捕获渲染异常，避免整个应用白屏 */}
        <ErrorBoundary>
          <Routes>
          <Route path="/:locale" element={<LocaleGate />}>
            <Route path="sign-in" element={<SignInPage />} />
            <Route path="activate" element={<ActivatePage />} />
            <Route path="forgot-password" element={<ForgotPasswordPage />} />
            <Route path="reset-password" element={<ResetPasswordPage />} />
            <Route element={<ShellRoute />}>
              <Route index element={<Navigate to="course" replace />} />
              <Route path="course" element={<CourseManagementPage />} />
              <Route path="course/:courseId" element={<CourseEditorPage />} />
              <Route path="course/:courseId/preview" element={<CoursePreviewPage />} />
              <Route
                path="knowledge"
                element={
                  <MenuGuard menu="knowledge">
                    <WorkspaceAccessProvider menu="knowledge">
                      <KnowledgeWorkspace />
                    </WorkspaceAccessProvider>
                  </MenuGuard>
                }
              />
              <Route
                path="ai-tutor"
                element={
                  <MenuGuard menu="aiTutor">
                    <WorkspaceAccessProvider menu="aiTutor">
                      <AITutorWorkspace />
                    </WorkspaceAccessProvider>
                  </MenuGuard>
                }
              />
              <Route path="order" element={<PlaceholderPage menu="order" />} />
              <Route path="reporting" element={<PlaceholderPage menu="reporting" />} />
              <Route path="student" element={<PlaceholderPage menu="student" />} />
              <Route
                // 一条路由带可选的 :ticketId：切换咨询时页面不重新挂载，左栏列表与滚动位置保持不变
                path="help-desk/:ticketId?"
                element={
                  <MenuGuard menu="helpDesk">
                    <WorkspaceAccessProvider menu="helpDesk">
                      <HelpDeskPage />
                    </WorkspaceAccessProvider>
                  </MenuGuard>
                }
              />
              <Route path="settings" element={<SettingsIndexPage />} />
              <Route path="settings/employee-account" element={<EmployeeAccountSettingsPage />} />
              <Route
                path="settings/payment-gateway"
                element={<SettingsEntryPage section="paymentGateway" />}
              />
              <Route
                path="settings/notification-configuration"
                element={<SettingsEntryPage section="notificationConfiguration" />}
              />
            </Route>
          </Route>
          <Route path="*" element={<LocaleFallback />} />
          </Routes>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  )
}

export default App
