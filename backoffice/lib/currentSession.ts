import { cookies } from "next/headers";

import type { SessionEmployee } from "@/contracts/employee";
import { SESSION_COOKIE_NAME } from "@/lib/sessionCookie";
import { decideEmployeeAccountAccess } from "@/modules/rbac/access";
import { resolveSession } from "@/modules/user-authentication/services/session";

/** 服务端组件与 Route Handler 共用的会话入口（PRD PORT-SES-001）。 */
export async function currentEmployee(): Promise<SessionEmployee | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE_NAME)?.value);
}

export async function currentSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * PRD §3.3：Employee Account Management 仅 Admin。
 * 判定统一走 modules/rbac/access，保证与单元测试使用同一份规则。
 */
export async function currentAdminEmployee(): Promise<SessionEmployee | null> {
  const employee = await currentEmployee();
  return decideEmployeeAccountAccess(employee).allowed ? employee : null;
}
