import { useEmployee } from '../employeeSession'
import {
  cachedAccountFeatures,
  courseActionAllowed,
  type AccountFeatures,
} from './capabilities'
import type { ActionKind } from '../rbac/permissions'

/**
 * 课程页面按钮的生效判定：会话 features 存在时逐项看服务端 effective
 * （course.view/edit/create/delete/publish/import/export），旧服务端回退角色矩阵。
 * 服务端仍是最终执行点；这里只决定按钮/表单是否可用，避免点了才 403。
 */
export type CoursePermissions = {
  view: boolean
  edit: boolean
  create: boolean
  delete: boolean
  publish: boolean
  import: boolean
  export: boolean
  can: (action: ActionKind) => boolean
}

export function coursePermissions(
  role: Parameters<typeof courseActionAllowed>[0],
  features: AccountFeatures = cachedAccountFeatures(),
): CoursePermissions {
  const can = (action: ActionKind) => courseActionAllowed(role, action, features)
  return {
    view: can('VIEW'),
    edit: can('EDIT_EXISTING'),
    create: can('CREATE'),
    delete: can('DELETE'),
    publish: can('PUBLISH'),
    import: can('IMPORT'),
    export: can('EXPORT'),
    can,
  }
}

export function useCoursePermissions(): CoursePermissions {
  const employee = useEmployee()
  // 不缓存：ShellRoute 在会话刷新后重渲染子树，账号开关变化要立即反映到按钮。
  return coursePermissions(employee.role)
}
