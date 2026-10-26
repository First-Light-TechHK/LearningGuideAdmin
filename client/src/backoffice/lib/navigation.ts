import { useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { DEFAULT_LOCALE, isLocale, type Locale } from './i18n/config'

export const SESSION_CHANGED_EVENT = 'lgbo:session-changed'

export function notifySessionChanged(): void {
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
}

/** 页面统一从路由参数取 locale（/:locale/...）。 */
export function useLocale(): Locale {
  const { locale } = useParams<{ locale?: string }>()
  return isLocale(locale) ? locale : DEFAULT_LOCALE
}

export function usePathname(): string {
  return useLocation().pathname
}

/** 与原 Next.js 页面同名的跳转接口，内部走 react-router。 */
export function useRouter() {
  const navigate = useNavigate()
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      // 原 Next.js 的 router.refresh()：会话变化后让外壳重新读取 /api/session
      refresh: () => notifySessionChanged(),
    }),
    [navigate],
  )
}

/** 从地址栏读取一次性令牌（激活 / 重置密码链接）。 */
export function useQueryToken(): { token: string; ready: boolean } {
  const { search } = useLocation()
  return useMemo(() => ({ token: new URLSearchParams(search).get('token') ?? '', ready: true }), [search])
}
