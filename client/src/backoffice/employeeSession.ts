import { createContext, useContext } from 'react'
import type { SessionEmployee } from './contracts/employee'
import { type MenuKey } from './rbac/permissions'

export type SessionPayload = { employee: SessionEmployee; sidebarState?: 'expanded' | 'collapsed' }

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'unavailable' }
  | { kind: 'signedIn'; employee: SessionEmployee; sidebarState: 'expanded' | 'collapsed' }

/** /api/session 返回这些码才说明真的没登录（会话无效、账号停用或未验证）。 */
export const SIGNED_OUT_CODES: ReadonlySet<string> = new Set([
  'INVALID_EMPLOYEE_ACCOUNT',
  'ACCOUNT_NOT_ACTIVE',
  'EMAIL_NOT_VERIFIED',
])

export const EmployeeContext = createContext<SessionEmployee | null>(null)

/** 外壳内页面读取当前员工（外壳保证已登录）。 */
export function useEmployee(): SessionEmployee {
  const employee = useContext(EmployeeContext)
  if (!employee) throw new Error('useEmployee must be used inside ShellRoute')
  return employee
}

/** Knowledge / AI Tutor 自带整宽 Tab 栏与课程树，内容区不留卡片内边距。 */
export const WORKSPACE_MENUS: ReadonlySet<MenuKey> = new Set(['knowledge', 'aiTutor'])
