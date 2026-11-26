import { Logger } from '@nestjs/common';

/**
 * Portal 通知集成接口（/api/integration/notifications/**）的唯一客户端。
 *
 * - 地址：PORTAL_NOTIFICATIONS_BASE_URL；令牌：PORTAL_NOTIFICATIONS_TOKEN（设计 §1）。
 * - Header `X-Notifications-Token`；Portal 校验失败 401，只允许服务调用。
 * - 任一未配置：503 NOTIFICATIONS_NOT_CONNECTED，且不发请求。
 * - Portal 的错误体是 `{ ok:false, code, error, ... }`；这里映射成 BackOffice 稳定错误码，
 *   成功体原样交给服务层（形状由 Portal 契约决定）。
 * - 事件接口（Admin→Portal 写入）也走这里；事件发送失败由调用方决定是否阻塞主流程。
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const BROADCAST_SEND_TIMEOUT_MS = 120_000;

export function notificationTimeoutMs(method: string, path: string, body: unknown): number {
  return method === 'PATCH' && /^\/broadcasts\/[^/]+$/.test(path) &&
    typeof body === 'object' && body !== null && 'action' in body && body.action === 'send'
    ? BROADCAST_SEND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export class NotificationsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NotificationsError';
  }
}

export type PortalNotificationsConfig = { baseUrl: string; token: string };

export function portalNotificationsConfig(): PortalNotificationsConfig | null {
  const rawBase = (
    process.env.PORTAL_NOTIFICATIONS_BASE_URL?.trim() || ''
  ).trim();
  const token = (process.env.PORTAL_NOTIFICATIONS_TOKEN?.trim() || '').trim();
  if (rawBase === '' || token === '') return null;
  try {
    const url = new URL(rawBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { baseUrl: rawBase.replace(/\/+$/, ''), token };
}

/** Portal code → BackOffice 错误码与状态；detail 仅在校验类错误时转给员工。 */
const ERROR_MAP: Record<
  string,
  { status: number; code: string; useDetail: boolean }
> = {
  invalid_request: { status: 400, code: 'INVALID_INPUT', useDetail: true },
  validation_failed: { status: 400, code: 'INVALID_INPUT', useDetail: true },
  invalid: { status: 400, code: 'INVALID_INPUT', useDetail: true },
  locked: { status: 400, code: 'TEMPLATE_LOCKED', useDetail: true },
  conflict: { status: 409, code: 'TEMPLATE_CONFLICT', useDetail: true },
  stale: { status: 409, code: 'TEMPLATE_CONFLICT', useDetail: true },
  not_found: { status: 404, code: 'NOT_FOUND', useDetail: false },
  no_learner: { status: 404, code: 'LEARNER_NOT_FOUND', useDetail: true },
  email_not_configured: {
    status: 503,
    code: 'EMAIL_NOT_CONFIGURED',
    useDetail: true,
  },
  email_failed: { status: 502, code: 'EMAIL_FAILED', useDetail: true },
};

function notConnected(): NotificationsError {
  return new NotificationsError(
    503,
    'NOTIFICATIONS_NOT_CONNECTED',
    'Notification Configuration is not connected yet',
  );
}

function unavailable(status = 502): NotificationsError {
  return new NotificationsError(
    status,
    'NOTIFICATIONS_UNAVAILABLE',
    'Notification Configuration is unavailable, please try again',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PortalNotificationsClient = {
  get: (path: string) => Promise<Record<string, unknown>>;
  send: (
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

export function createPortalNotificationsClient(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): PortalNotificationsClient {
  const logger = new Logger('PortalNotificationsClient');
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? notificationTimeoutMs(method, path, body);
    const config = portalNotificationsConfig();
    if (!config) throw notConnected();
    const headers: Record<string, string> = {
      'x-notifications-token': config.token,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(
        `${config.baseUrl}/api/integration/notifications${path}`,
        {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.warn(`Portal notifications timed out after ${timeoutMs}ms`);
        throw unavailable(504);
      }
      logger.warn('Portal notifications is unreachable');
      throw unavailable();
    }
    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text.trim() ? (JSON.parse(text) as unknown) : null;
    } catch {
      if (response.ok) throw unavailable();
    }
    if (!response.ok) {
      const record = isRecord(parsed) ? parsed : {};
      const code = typeof record.code === 'string' ? record.code : '';
      if (
        response.status === 401 ||
        code === 'invalid_token' ||
        code === 'integration_disabled'
      ) {
        logger.error(`Portal rejected the notifications token (${code})`);
        throw notConnected();
      }
      const mapped = ERROR_MAP[code];
      if (!mapped) {
        logger.warn(
          `Portal notifications answered ${response.status} ${code || '(no code)'}`,
        );
        throw unavailable();
      }
      const detail =
        mapped.useDetail && typeof record.error === 'string'
          ? record.error.slice(0, 300)
          : undefined;
      throw new NotificationsError(
        mapped.status,
        mapped.code,
        detail || 'Request failed',
        {
          ...(record.current !== undefined ? { current: record.current } : {}),
          ...(record.issues !== undefined ? { issues: record.issues } : {}),
          ...(record.logId !== undefined ? { logId: record.logId } : {}),
        },
      );
    }
    if (!isRecord(parsed)) throw unavailable();
    return parsed;
  }

  return {
    get: (path) => request('GET', path),
    send: (method, path, body) => request(method, path, body),
  };
}
