import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { boRequest } from './lib/api';
import {
  accountFeaturesFromSession,
  accountMenus,
  capabilitiesForSegments,
  capabilitiesFromEnvironment,
  featureRequirementForSegments,
  filterMenusByCapabilities,
  landingMenuFor,
  rememberAccountFeatures,
  rememberEnvironment,
  type AccountFeatures,
  type CapabilityId,
  type EnvironmentResponse,
} from './lib/capabilities';
import { rememberEnvironmentIdentity, resolveEnvironment } from './lib/environment';
import { t } from './lib/i18n/messages';
import { SESSION_CHANGED_EVENT, useLocale, usePathname } from './lib/navigation';
import { menuFromPathSegments, menuHref, visibleMenus } from './rbac/permissions';
import { SIGNED_OUT_CODES, EmployeeContext, WORKSPACE_MENUS } from './employeeSession';
import type { SessionPayload, SessionState } from './employeeSession';

/**
 * 登录后外壳：服务端 /api/session 是唯一事实来源。
 * 未登录跳到登录页；会话变化（登出、改密、接口 401）时重新读取。
 * 能力集（ADMIN_CAPABILITIES）来自环境端点：菜单 = 角色权限 ∩ 已启用能力；
 * 账号级功能键（/api/session 的 features，服务端 effective）再收一层：
 * settings 由 module.settings / module.accounts 任一打开，员工账号子页只认 module.accounts。
 * 被禁止的菜单/路由直接重定向到第一个同时满足角色、环境能力与账号功能的菜单。
 */
export function ShellRoute() {
  const locale = useLocale()
  const pathname = usePathname()
  const [state, setState] = useState<SessionState>({ kind: 'loading' })
  // null = 还在读；读完后是“全开”（字段缺失/旧服务端/读取失败）或启用子集
  const [capabilities, setCapabilities] = useState<ReadonlySet<CapabilityId> | null>(null)
  // undefined = 会话还没回来；null = 旧服务端（不额外限制）；Set = 该账号生效的功能键
  const [accountFeatures, setAccountFeatures] = useState<AccountFeatures | undefined>(undefined)
  const [appEnv, setAppEnv] = useState<string | null>(null)
  const [envLabel, setEnvLabel] = useState<string | null>(null)

  const load = useCallback(() => {
    return boRequest<SessionPayload>('/api/session').then((result) => {
      if (result.success) {
        setState({
          kind: 'signedIn',
          employee: result.data.employee,
          sidebarState: result.data.sidebarState === 'collapsed' ? 'collapsed' : 'expanded',
        })
        // 账号功能键随会话一起刷新（角色/开关在别处被改后，切回标签页即生效）
        rememberAccountFeatures(result.data)
        setAccountFeatures(accountFeaturesFromSession(result.data))
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

  // 能力集只读一次：环境端点缺 capabilities 字段（旧服务端）或读取失败 = 全开。
  // 服务端仍会拦截禁用模块，这里只决定菜单与路由显示。
  // 同一份结果写进 capabilities.ts 的模块级缓存：外壳内页面（预览入口、Operations 按钮）同步读取。
  useEffect(() => {
    void boRequest<EnvironmentResponse>('/api/backoffice/environment').then((result) => {
      const payload = result.success ? result.data : null
      rememberEnvironment(payload)
      setEnvLabel(payload?.label ?? null)
      setCapabilities(capabilitiesFromEnvironment(payload))
    })
  }, [])

  // 环境种类只认 /api/health 的 APP_ENV（环境端点分不清 DEV 与 Sandbox）；读不到 = 中性墙 + “未知环境”，不阻塞首屏。
  useEffect(() => {
    void boRequest<{ environment?: string }>('/api/health').then((result) => {
      setAppEnv(result.success && typeof result.data?.environment === 'string' ? result.data.environment : null)
    })
  }, [])

  const environment = useMemo(() => resolveEnvironment(appEnv, envLabel), [appEnv, envLabel])
  useEffect(() => {
    rememberEnvironmentIdentity(environment)
  }, [environment])

  if (state.kind === 'loading' || capabilities === null || accountFeatures === undefined) {
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

  const segments = pathname.split('/').filter(Boolean).slice(1)
  const roleMenus = visibleMenus(state.employee.role)
  // 服务端 features 已含 环境 ∩ 角色 ± 账号开关：有 features 时以它为准（可加可减），旧服务端回退角色菜单
  const candidateMenus = accountMenus(roleMenus, accountFeatures)
  const menus = filterMenusByCapabilities(candidateMenus, capabilities)
  // 路由门 = 环境能力 ∩ 账号功能：任一集合命中即放行；旧服务端（features 缺失）不额外限制
  const requiredCapabilities = capabilitiesForSegments(segments)
  const requiredFeatures = featureRequirementForSegments(segments)
  const missingCapability =
    requiredCapabilities !== null && !requiredCapabilities.some((id) => capabilities.has(id))
  const missingFeature =
    accountFeatures !== null &&
    requiredFeatures !== null &&
    (!requiredFeatures.allOf.every((key) => accountFeatures.has(key)) ||
      (requiredFeatures.anyOf.length > 0 &&
        !requiredFeatures.anyOf.some((key) => accountFeatures.has(key))))
  if (missingCapability || missingFeature) {
    const landing = landingMenuFor(candidateMenus, capabilities, accountFeatures)
    return landing === null ? <NoModulesCard /> : <Navigate to={menuHref(locale, landing)} replace />
  }

  const menu = menuFromPathSegments(segments)
  return (
    <EmployeeContext.Provider value={state.employee}>
      <AppShell
        employee={state.employee}
        menus={menus}
        workspace={menu !== null && WORKSPACE_MENUS.has(menu)}
        initialCollapsed={state.sidebarState === 'collapsed'}
      >
        <Outlet />
      </AppShell>
    </EmployeeContext.Provider>
  )
}

/** 所有菜单都被能力门关掉时的兜底：没有重定向落点，直接说明（不循环跳转）。 */
function NoModulesCard() {
  const locale = useLocale()
  return (
    <div className="shellLoading">
      <p>{t(locale, 'shell.noModulesEnabled')}</p>
    </div>
  )
}