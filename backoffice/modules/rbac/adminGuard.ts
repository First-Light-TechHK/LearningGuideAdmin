import { NextResponse } from "next/server";

import type { SessionEmployee } from "@/contracts/employee";
import { clientIp, jsonFail } from "@/lib/http";
import { currentEmployee } from "@/lib/currentSession";
import { canAccessEmployeeAccount } from "@/modules/rbac/permissions";
import { tryRecordAuditEvent } from "@/repositories/auditRepository";

export type AdminGuardResult =
  | { ok: true; admin: SessionEmployee }
  | { ok: false; response: NextResponse };

/**
 * PRD §3.3 / §11.1：Employee Account 相关 API 的统一守卫。
 * 无会话 → 401；有会话但角色不足 → 403，并记录 permission_denied 审计事件。
 */
export async function requireAdmin(request: Request): Promise<AdminGuardResult> {
  const employee = await currentEmployee();
  if (!employee) {
    return { ok: false, response: jsonFail("INVALID_EMPLOYEE_ACCOUNT", "No active session") };
  }

  if (canAccessEmployeeAccount(employee.role)) {
    return { ok: true, admin: employee };
  }

  await tryRecordAuditEvent({
    eventName: "permission_denied",
    actorEmployeeId: employee.employeeId,
    targetEmployeeId: null,
    action: "EMPLOYEE_ACCOUNT_ADMIN_API",
    newValue: `${request.method} ${new URL(request.url).pathname}`,
    result: "DENIED",
    ipAddress: clientIp(request),
  });

  return { ok: false, response: jsonFail("NOT_AUTHORISED", "Admin only") };
}
