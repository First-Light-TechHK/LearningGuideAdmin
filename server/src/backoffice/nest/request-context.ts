import type { Request } from 'express';

import type { SessionEmployee } from '../contracts/employee';
import { configuredAppBaseUrl } from '../lib/env';
import { SESSION_COOKIE_NAME } from './cookies';

export type BackofficeRequest = Request & { employee?: SessionEmployee };

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionToken(request: Request): string | undefined {
  return readCookie(request, SESSION_COOKIE_NAME);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  return first || request.ip || 'unknown';
}

export function userAgent(request: Request): string | null {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : null;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ADMIN_ORIGIN =
  /^https:\/\/admin(\.[a-z0-9-]+)*\.ilovelearningguide\.com$/;

/**
 * 邮件链接的站点根：BACKOFFICE_APP_URL 优先；否则取发起操作的浏览器 Origin，
 * 只认本地开发与 admin.*.ilovelearningguide.com，防止 Origin 伪造成钓鱼链接。
 */
export function appUrlFor(request: Request): string {
  const configured = configuredAppBaseUrl();
  if (configured) return configured;
  const origin = request.headers.origin;
  if (
    typeof origin === 'string' &&
    (LOCAL_ORIGIN.test(origin) || ADMIN_ORIGIN.test(origin))
  ) {
    return origin;
  }
  return 'https://admin.ilovelearningguide.com';
}
