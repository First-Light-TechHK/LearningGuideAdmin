"use client";

import { useParams } from "next/navigation";

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";

/** 客户端页面统一从这里取 locale，避免每个页面重复解析 params。 */
export function useLocale(): Locale {
  const params = useParams<{ locale?: string }>();
  const value = params?.locale;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
