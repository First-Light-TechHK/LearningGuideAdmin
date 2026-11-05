import { createContext, useContext } from 'react'
import {
  isActionAllowed,
  levelFor,
  type ActionKind,
  type MenuKey,
  type PermissionLevel,
} from '../rbac/permissions'

/**
 * 工作区（Knowledge / AI Tutor）的按角色读写能力。
 * PRD §3.2「View = 只读」+ §3.3「限制须同时作用于 UI 与后端 API」：
 * 后端 API 仍是最终安全边界，这里只负责把界面做成对应角色应有的形态。
 */
export type WorkspaceAccess = {
  menu: MenuKey
  level: PermissionLevel
  /** VIEW：完全只读，不能改任何内容 */
  readOnly: boolean
  /** 可修改既有内容（EDIT 或 FULL） */
  canEdit: boolean
  canCreate: boolean
  canDelete: boolean
  canPublish: boolean
  can: (action: ActionKind) => boolean
}

export function buildAccess(role: Parameters<typeof levelFor>[0], menu: MenuKey): WorkspaceAccess {
  const level = levelFor(role, menu)
  return {
    menu,
    level,
    readOnly: level === 'VIEW',
    canEdit: isActionAllowed(role, menu, 'EDIT_EXISTING'),
    canCreate: isActionAllowed(role, menu, 'CREATE'),
    canDelete: isActionAllowed(role, menu, 'DELETE'),
    canPublish: isActionAllowed(role, menu, 'PUBLISH'),
    can: (action) => isActionAllowed(role, menu, action),
  }
}

export const WorkspaceAccessContext = createContext<WorkspaceAccess | null>(null)

export function useWorkspaceAccess(): WorkspaceAccess {
  const value = useContext(WorkspaceAccessContext)
  if (!value) {
    throw new Error('useWorkspaceAccess must be used within a WorkspaceAccessProvider')
  }
  return value
}
