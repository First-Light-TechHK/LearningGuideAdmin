import enGB from "../../messages/en-GB.json";
import zhCN from "../../messages/zh-CN.json";

import { DEFAULT_LOCALE, type Locale } from "./config";

export type Messages = typeof enGB;

const BUNDLES: Record<Locale, Messages> = {
  "en-GB": enGB,
  "zh-CN": zhCN,
};

export function getMessages(locale: Locale): Messages {
  return BUNDLES[locale];
}

function lookup(source: unknown, key: string): string | undefined {
  let cursor: unknown = source;
  for (const segment of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * 点号路径取值；缺失时回退默认语言，再回退 key 本身，
 * 保证漏翻不会导致页面崩溃。
 */
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const resolved =
    lookup(BUNDLES[locale], key) ?? lookup(BUNDLES[DEFAULT_LOCALE], key) ?? key;
  if (!vars) return resolved;
  return resolved.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
