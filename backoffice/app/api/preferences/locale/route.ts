import { NextResponse } from "next/server";

import { ok, type Envelope } from "@/contracts/envelope";
import { currentEmployee } from "@/lib/currentSession";
import { jsonFail, readJson, readString } from "@/lib/http";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { LOCALE_COOKIE_NAME, localeCookieOptions } from "@/lib/localeCookie";
import * as preferencesRepository from "@/repositories/preferencesRepository";

/**
 * PORT-NAV-006：记录账号级语言偏好。
 * 未登录时无需调用——middleware 会按 URL 写入 Cookie。
 */
export async function POST(request: Request): Promise<Response> {
  const employee = await currentEmployee();
  if (!employee) return jsonFail("INVALID_EMPLOYEE_ACCOUNT", "No active session");

  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const locale = readString(body, "locale");
  if (!isLocale(locale)) return jsonFail("INVALID_INPUT", "Unsupported locale");

  try {
    await preferencesRepository.upsertLocale(employee.employeeId, locale);
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to save language preference");
  }

  const response = NextResponse.json<Envelope<{ locale: Locale }>>(ok({ locale }));
  response.cookies.set({ name: LOCALE_COOKIE_NAME, ...localeCookieOptions(locale) });
  return response;
}
