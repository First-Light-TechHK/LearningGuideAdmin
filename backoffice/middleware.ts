import { NextResponse, type NextRequest } from "next/server";

import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { LOCALE_COOKIE_NAME, localeCookieOptions } from "@/lib/localeCookie";

const LOCALE_PREFIX = /^\/(en-GB|zh-CN)(?=\/|$)/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * PORT-SEC-004：Cookie 之外的第二道 CSRF 防线。
 * 浏览器带 Origin 的跨站写请求一律拒绝；不带 Origin 的（curl、服务端）放行，
 * 它们仍需通过会话与角色校验。
 */
function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) return null;

  const origin = request.headers.get("origin");
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: "NOT_AUTHORISED", message: "Invalid origin" },
      { status: 403 }
    );
  }

  const host = request.headers.get("host");
  if (host && originHost !== host) {
    return NextResponse.json(
      { success: false, data: null, error: "NOT_AUTHORISED", message: "Cross-origin request blocked" },
      { status: 403 }
    );
  }
  return null;
}

/**
 * native i18n 入口 + 语言偏好同步：
 * - API 路径：只做 CSRF 检查，不做语言重定向
 * - 带 locale 的路径：写入/刷新 lgbo_locale Cookie，并注入 x-locale 供根 layout 用
 * - 不带 locale 的路径：按 Cookie 偏好重定向，没有偏好则用默认语言
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    return rejectCrossOrigin(request) ?? NextResponse.next();
  }

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
  matcher: ["/((?!_next|favicon.ico|.*\\.[^/]+$).*)"],
};
