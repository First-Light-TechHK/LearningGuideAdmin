import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import type { SessionEmployee } from './contracts/employee'
import { boRequest } from './lib/api'
import { t } from './lib/i18n/messages'
import { SESSION_CHANGED_EVENT, useLocale, usePathname } from './lib/navigation'
import { menuFromPathSegments, type MenuKey } from './rbac/permissions'

type SessionPayload = { employee: SessionEmployee; sidebarState?: 'expanded' | 'collapsed' }

type SessionState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'signedIn'; employee: SessionEmployee; sidebarState: 'expanded' | 'collapsed' }

const EmployeeContext = createContext<SessionEmployee | null>(null)

/** 外壳内页面读取当前员工（外壳保证已登录）。 */
export function useEmployee(): SessionEmployee {
  const employee = useContext(EmployeeContext)
  if (!employee) throw new Error('useEmployee must be used inside ShellRoute')
  return employee
}

/** Knowledge / AI Tutor 自带整宽 Tab 栏与课程树，内容区不留卡片内边距。 */
const WORKSPACE_MENUS: ReadonlySet<MenuKey> = new Set(['knowledge', 'aiTutor'])

/**
 * 登录后外壳：服务端 /api/session 是唯一事实来源。
 * 未登录跳到登录页；会话变化（登出、改密、接口 401）时重新读取。
 */
export function ShellRoute() {
  const locale = useLocale()
  const pathname = usePathname()
  const [state, setState] = useState<SessionState>({ kind: 'loading' })

  const load = useCallback(async () => {
    const result = await boRequest<SessionPayload>('/api/session')
    setState(
      result.success
        ? {
            kind: 'signedIn',
            employee: result.data.employee,
            sidebarState: result.data.sidebarState === 'collapsed' ? 'collapsed' : 'expanded',
          }
        : { kind: 'signedOut' },
    )
  }, [])

  useEffect(() => {
    void load()
    const onChange = () => void load()
    window.addEventListener(SESSION_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onChange)
  }, [load])

  if (state.kind === 'loading') {
    return <div className="shellLoading">{t(locale, 'common.loading')}</div>
  }
  if (state.kind === 'signedOut') {
    return <Navigate to={`/${locale}/sign-in`} replace />
  }

  const menu = menuFromPathSegments(pathname.split('/').filter(Boolean).slice(1))
  return (
    <EmployeeContext.Provider value={state.employee}>
      <AppShell
        employee={state.employee}
        workspace={menu !== null && WORKSPACE_MENUS.has(menu)}
        initialCollapsed={state.sidebarState === 'collapsed'}
      >
        <Outlet />
      </AppShell>
    </EmployeeContext.Provider>
  )
}
