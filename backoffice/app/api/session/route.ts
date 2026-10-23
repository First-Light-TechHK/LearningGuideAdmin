import { currentEmployee } from "@/lib/currentSession";
import { jsonFail, jsonOk } from "@/lib/http";
import { coerceLocale, requestedLocale } from "@/lib/localePreference";
import {
  canAccessEmployeeAccount,
  DEFAULT_LANDING_MENU,
  employeeAccountHref,
  menuHref,
  visibleMenus,
} from "@/modules/rbac/permissions";

export type SessionPayload = {
  employee: {
    employeeId: string;
    loginEmail: string;
    displayName: string;
    role: string;
    displayStatus: string;
    isBootstrapAdmin: boolean;
  };
  locale: string;
  menus: { key: string; href: string }[];
  canManageEmployeeAccount: boolean;
  employeeAccountHref: string;
  landingHref: string;
};

export async function GET(request: Request): Promise<Response> {
  try {
    const employee = await currentEmployee();
    if (!employee) return jsonFail("INVALID_EMPLOYEE_ACCOUNT", "No active session");

    // API 路径不含语言前缀，locale 只能来自显式参数或 Cookie 偏好
    const explicit = coerceLocale(new URL(request.url).searchParams.get("locale"));
    const locale = explicit ?? (await requestedLocale());

    return jsonOk<SessionPayload>({
      employee: {
        employeeId: employee.employeeId,
        loginEmail: employee.loginEmail,
        displayName: employee.displayName,
        role: employee.role,
        displayStatus: employee.displayStatus,
        isBootstrapAdmin: employee.isBootstrapAdmin,
      },
      locale,
      menus: visibleMenus(employee.role).map((menu) => ({
        key: menu,
        href: menuHref(locale, menu),
      })),
      canManageEmployeeAccount: canAccessEmployeeAccount(employee.role),
      employeeAccountHref: employeeAccountHref(locale),
      landingHref: menuHref(locale, DEFAULT_LANDING_MENU),
    });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to read session");
  }
}
