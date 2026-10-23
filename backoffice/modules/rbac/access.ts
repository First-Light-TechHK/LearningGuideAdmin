import type { ErrorCode } from "@/contracts/envelope";
import type { SessionEmployee } from "@/contracts/employee";

import { canAccessEmployeeAccount, canViewMenu, type MenuKey } from "./permissions";

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; code: Extract<ErrorCode, "INVALID_EMPLOYEE_ACCOUNT" | "NOT_AUTHORISED"> };

type EmployeeLike = Pick<SessionEmployee, "role"> | null;

/**
 * 未登录与无权限必须给出可区分的结论：
 * - 无会话 → INVALID_EMPLOYEE_ACCOUNT（401）
 * - 有会话但角色不够 → NOT_AUTHORISED（403）
 * 抽成纯函数是为了让守卫逻辑可被单元测试直接覆盖。
 */
export function decideEmployeeAccountAccess(employee: EmployeeLike): AccessDecision {
  if (!employee) return { allowed: false, code: "INVALID_EMPLOYEE_ACCOUNT" };
  if (!canAccessEmployeeAccount(employee.role)) {
    return { allowed: false, code: "NOT_AUTHORISED" };
  }
  return { allowed: true };
}

export function decideMenuAccess(employee: EmployeeLike, menu: MenuKey): AccessDecision {
  if (!employee) return { allowed: false, code: "INVALID_EMPLOYEE_ACCOUNT" };
  if (!canViewMenu(employee.role, menu)) return { allowed: false, code: "NOT_AUTHORISED" };
  return { allowed: true };
}
