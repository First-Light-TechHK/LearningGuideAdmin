import { NextResponse, type NextRequest } from "next/server";

import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { LOCALE_COOKIE_NAME, localeCookieOptions } from "@/lib/localeCookie";

const LOCALE_PREFIX = /^\/(en-GB|zh-CN)(?=\/|$)/;

/**
 * native i18n 入口 + 语言偏好同步：
 * - 带 locale 的路径：写入/刷新 lgbo_locale Cookie，并注入 x-locale 供根 layout 用
 * - 不带 locale 的路径：按 Cookie 偏好重定向，没有偏好则用默认语言
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const pathLocale = LOCALE_PREFIX.test(pathname) ? pathname.split("/")[1] : undefined;

  if (isLocale(pathLocale)) {
    const headers = new Headers(request.headers);
    headers.set("x-locale", pathLocale);

    const response = NextResponse.next({ request: { headers } });
    if (request.cookies.get(LOCALE_COOKIE_NAME)?.value !== pathLocale) {
      response.cookies.set({ name: LOCALE_COOKIE_NAME, ...localeCookieOptions(pathLocale) });
    }
    return response;
  }

  const cookieLocale = request.cookies.get(LOCALE_COOKIE_NAME)?.value;
  const target = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const url = request.nextUrl.clone();
  url.pathname = `/${target}${pathname === "/" ? "" : pathname}`;
  url.search = search;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|.*\\.[^/]+$).*)"],
};
