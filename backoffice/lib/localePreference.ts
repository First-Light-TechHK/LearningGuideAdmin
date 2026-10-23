import { cookies } from "next/headers";

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";
import { LOCALE_COOKIE_NAME } from "@/lib/localeCookie";

/** 服务端读取当前语言偏好（Cookie 优先，回退默认语言）。 */
export async function requestedLocale(): Promise<Locale> {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE_NAME)?.value;
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/** 把任意来源的值收敛成合法 locale。 */
export function coerceLocale(value: string | null | undefined): Locale | null {
  return isLocale(value) ? value : null;
}
