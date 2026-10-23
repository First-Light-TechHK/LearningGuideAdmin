import type { CookieOptions, Response } from 'express';

import type { Locale } from '../lib/i18n/config';

export const SESSION_COOKIE_NAME = 'lgbo_session';
export const LOCALE_COOKIE_NAME = 'lgbo_locale';
const LOCALE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function base(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function setSessionCookie(
  response: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  response.cookie(SESSION_COOKIE_NAME, token, {
    ...base(),
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, base());
}

export function setLocaleCookie(response: Response, locale: Locale): void {
  response.cookie(LOCALE_COOKIE_NAME, locale, {
    ...base(),
    maxAge: LOCALE_MAX_AGE_MS,
  });
}
