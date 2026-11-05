import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { boRequest } from './lib/api';
import { t } from './lib/i18n/messages';
import { SESSION_CHANGED_EVENT, useLocale, usePathname } from './lib/navigation';
import { menuFromPathSegments } from './rbac/permissions';
import { SIGNED_OUT_CODES, EmployeeContext, WORKSPACE_MENUS } from './employeeSession';
import type { SessionPayload, SessionState } from './employeeSession';

/**
 * 登录后外壳：服务端 /api/session 是唯一事实来源。
 * 未登录跳到登录页；会话变化（登出、改密、接口 401）时重新读取。
 */
export function ShellRoute() {
  const locale = useLocale()
  const pathname = usePathname()
  const [state, setState] = useState<SessionState>({ kind: 'loading' })

  const load = useCallback(() => {
    return boRequest<SessionPayload>('/api/session').then((result) => {
      if (result.success) {
        setState({
          kind: 'signedIn',
          employee: result.data.employee,
          sidebarState: result.data.sidebarState === 'collapsed' ? 'collapsed' : 'expanded',
        })
        return
      }
      // 只有服务端明确说会话无效才登出；断网或 5xx 时保留当前页面，首次加载则提示重试
      if (SIGNED_OUT_CODES.has(result.error)) setState({ kind: 'signedOut' })
      else setState((previous) => (previous.kind === 'signedIn' ? previous : { kind: 'unavailable' }))
    })
  }, [])

  useEffect(() => {
    void load()
    const onChange = () => void load()
    // 切回这个标签页时重读一次：角色或状态可能在别处被改过
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener(SESSION_CHANGED_EVENT, onChange)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, onChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  if (state.kind === 'loading') {
    return <div className="shellLoading">{t(locale, 'common.loading')}</div>
  }
  if (state.kind === 'unavailable') {
    return (
      <div className="shellLoading">
        <p>{t(locale, 'common.sessionUnavailable')}</p>
        <button type="button" className="button" onClick={() => void load()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    )
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