export const LOCALES = ['en-GB', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-GB';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en-GB' || value === 'zh-CN';
}

export function otherLocale(locale: Locale): Locale {
  return locale === 'en-GB' ? 'zh-CN' : 'en-GB';
}

/** 语言切换保留当前路径（PRD PORT-NAV-006）。 */
export function localeHref(pathname: string, locale: Locale): string {
  if (/^\/(en-GB|zh-CN)(?:\/|$)/.test(pathname)) {
    return pathname.replace(/^\/(en-GB|zh-CN)/, `/${locale}`);
  }
  return `/${locale}/course`;
}
