import type { Locale } from "@/lib/i18n/config";

/**
 * 语言偏好的运行时载体。
 * 放在独立文件里是为了让 middleware（edge）与 Route Handler 共用同一份定义，
 * 同时避免把 next/headers 带进 edge 运行时。
 */
export const LOCALE_COOKIE_NAME = "lgbo_locale";

export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function localeCookieOptions(locale: Locale) {
  return {
    value: locale,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
  };
}
