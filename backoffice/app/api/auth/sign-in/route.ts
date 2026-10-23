import { NextResponse } from "next/server";

import { ok, type Envelope } from "@/contracts/envelope";
import type { SessionEmployee } from "@/contracts/employee";
import { clientIp, jsonFail, readJson, readString } from "@/lib/http";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { LOCALE_COOKIE_NAME, localeCookieOptions } from "@/lib/localeCookie";
import { requestedLocale } from "@/lib/localePreference";
import { RATE_LIMIT_WINDOW_MINUTES, SIGN_IN_MAX_PER_WINDOW } from "@/lib/securityPolicy";
import { consume } from "@/lib/rateLimit";
import { sessionCookieOptions } from "@/lib/sessionCookie";
import { tryRecordAuditEvent } from "@/repositories/auditRepository";
import * as preferencesRepository from "@/repositories/preferencesRepository";
import { signIn } from "@/modules/user-authentication/services/signIn";

/**
 * PORT-LOG-004 / PORT-LOG-005：登录成功即建立服务端会话。
 * PORT-NAV-006：登录时把账号级语言偏好写回 Cookie，并告知前端应落在哪个语言前缀。
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const ip = clientIp(request);
  const limit = consume(`sign-in:${ip}`, SIGN_IN_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES);
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many sign-in attempts");

  try {
    const outcome = await signIn({
      rawEmail: readString(body, "email"),
      password: readString(body, "password"),
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
    });

    if (!outcome.ok) return jsonFail(outcome.code, "Sign-in rejected");

    const stored = await preferencesRepository
      .findLocale(outcome.employee.employeeId)
      .catch(() => null);
    const locale: Locale = isLocale(stored) ? stored : await requestedLocale();

    const response = NextResponse.json<Envelope<{ employee: SessionEmployee; locale: Locale }>>(
      ok({ employee: outcome.employee, locale }),
      { status: 200 }
    );
    response.cookies.set({
      ...sessionCookieOptions(outcome.maxAgeSeconds),
      value: outcome.token,
    });
    response.cookies.set({ name: LOCALE_COOKIE_NAME, ...localeCookieOptions(locale) });

    await tryRecordAuditEvent({
      eventName: "employee_login_succeeded",
      actorEmployeeId: outcome.employee.employeeId,
      targetEmployeeId: outcome.employee.employeeId,
      action: "SIGN_IN",
      result: "SUCCESS",
      ipAddress: ip,
    });

    return response;
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to complete sign-in");
  }
}
