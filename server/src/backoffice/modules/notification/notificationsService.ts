import type { SessionEmployee } from '../../contracts/employee';
import type { AuditEventInput } from '../../repositories/auditRepository';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_LANGUAGES,
  type NotificationTemplate,
} from './contracts';
import {
  NotificationsError,
  type PortalNotificationsClient,
} from './portalNotificationsClient';

/**
 * Notification Configuration 的 Admin 服务：转发、操作人注入、BackOffice 审计。
 * 文案限长、变量、中文成对、按钮、锁定等业务校验只在 Portal 做（它返回带建议的
 * `validation_failed` / `locked`，客户端把它们映射成 400 INVALID_INPUT / TEMPLATE_LOCKED），
 * 这里不再保留第二份规则。权限由全局守卫按 settings + Admin-only 校验。
 */

/** 拼进 Portal 路径的 ID：只允许字母数字、下划线和连字符（挡住 `..`、`a/b`）。 */
const ID = /^[A-Za-z0-9_-]{1,80}$/;

const TEMPLATE_FIELDS = ['enabled', 'en', 'zh', 'expectedUpdatedAt'] as const;
const BROADCAST_FIELDS = [
  'titleEn',
  'bodyEn',
  'titleZh',
  'bodyZh',
  'buttonText',
  'buttonLink',
  'audience',
] as const;
const SEND_LOG_FILTERS = [
  'recipient',
  'template',
  'broadcast',
  'status',
  'from',
  'to',
  'page',
] as const;

function invalid(message: string): NotificationsError {
  return new NotificationsError(400, 'INVALID_INPUT', message);
}

function bodyOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw invalid('Request body must be an object');
  return raw as Record<string, unknown>;
}

function idOf(raw: unknown): string {
  if (typeof raw !== 'string' || !ID.test(raw))
    throw invalid('id is not valid');
  return raw;
}

function oneOf<T extends string>(
  values: readonly T[],
  raw: unknown,
  field: string,
): T {
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw))
    return raw as T;
  throw invalid(`${field} is not valid`);
}

/** 只转发白名单里出现的字段；操作人、邮箱一律来自会话，不来自请求体。 */
function pick(
  body: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => field in body)
      .map((field) => [field, body[field]]),
  );
}

function actorOf(employee: SessionEmployee): string {
  return employee.displayName || employee.loginEmail;
}

export type NotificationsService = ReturnType<
  typeof createNotificationsService
>;

export function createNotificationsService(deps: {
  portal: PortalNotificationsClient;
  audit: (event: AuditEventInput) => Promise<void>;
}) {
  const { portal } = deps;

  async function audit(
    employee: SessionEmployee,
    eventName: string,
    action: string,
    values: { before?: unknown; after?: unknown },
    result: AuditEventInput['result'] = 'SUCCESS',
  ) {
    await deps.audit({
      eventName,
      actorEmployeeId: employee.employeeId,
      targetEmployeeId: null,
      action,
      oldValue:
        values.before === undefined ? null : JSON.stringify(values.before),
      newValue:
        values.after === undefined ? null : JSON.stringify(values.after),
      result,
    });
  }

  /** 失败也记一笔（被拒的敏感操作同样要可追溯），再把原错误抛回给员工。 */
  async function audited<T>(
    employee: SessionEmployee,
    eventName: string,
    action: string,
    request: unknown,
    work: () => Promise<T>,
    before?: () => Promise<unknown>,
  ): Promise<T> {
    const previous = before ? await before().catch(() => undefined) : undefined;
    try {
      const result = await work();
      await audit(
        employee,
        eventName,
        action,
        { before: previous, after: request },
        'SUCCESS',
      );
      return result;
    } catch (error) {
      if (error instanceof NotificationsError && error.status < 500)
        await audit(
          employee,
          eventName,
          action,
          { before: previous, after: { request, error: error.code } },
          'FAILURE',
        );
      throw error;
    }
  }

  async function templates(): Promise<{
    ok: true;
    templates: NotificationTemplate[];
  }> {
    const body = await portal.get('/templates');
    return body as unknown as { ok: true; templates: NotificationTemplate[] };
  }

  /** 审计的“之前”：Portal 的写入响应只带保存后的模板，所以保存前读一次。 */
  async function templateBefore(id: string): Promise<unknown> {
    return (await templates()).templates.find((item) => item.id === id);
  }

  async function updateTemplate(
    employee: SessionEmployee,
    rawId: string,
    rawBody: unknown,
  ) {
    const id = idOf(rawId);
    const body = bodyOf(rawBody);
    const payload = {
      ...pick(body, TEMPLATE_FIELDS),
      operator: actorOf(employee),
    };
    const eventName =
      'enabled' in body && !('en' in body) && !('zh' in body)
        ? 'template_toggled'
        : 'template_saved';
    return audited(
      employee,
      eventName,
      `notification-template:${id}`,
      payload,
      () => portal.send('PUT', `/templates/${id}`, payload),
      () => templateBefore(id),
    );
  }

  async function testTemplate(
    employee: SessionEmployee,
    rawId: string,
    rawBody: unknown,
  ) {
    const id = idOf(rawId);
    const body = bodyOf(rawBody);
    const channel = oneOf(NOTIFICATION_CHANNELS, body.channel, 'channel');
    const language = oneOf(NOTIFICATION_LANGUAGES, body.language, 'language');
    const payload = {
      channel,
      language,
      ...pick(body, ['copy']),
      operatorEmail: employee.loginEmail,
      operator: actorOf(employee),
    };
    return audited(
      employee,
      'test_sent',
      `notification-template:${id}`,
      { channel, language },
      () => portal.send('POST', `/templates/${id}/test`, payload),
    );
  }

  async function audiences() {
    return portal.get('/audiences');
  }

  async function listBroadcasts(rawPage?: unknown) {
    const page = Number(rawPage ?? '1');
    if (!Number.isInteger(page) || page < 1)
      throw invalid('page must be a positive integer');
    return portal.get(`/broadcasts?page=${page}`);
  }

  async function broadcastDetail(rawId: string) {
    return portal.get(`/broadcasts/${idOf(rawId)}`);
  }

  async function createBroadcast(employee: SessionEmployee, rawBody: unknown) {
    const payload = {
      ...pick(bodyOf(rawBody), BROADCAST_FIELDS),
      operator: actorOf(employee),
    };
    return audited(
      employee,
      'broadcast_draft_saved',
      'notification-broadcast',
      payload,
      () => portal.send('POST', '/broadcasts', payload),
    );
  }

  async function patchBroadcast(
    employee: SessionEmployee,
    rawId: string,
    rawBody: unknown,
  ) {
    const id = idOf(rawId);
    const body = bodyOf(rawBody);
    const action = oneOf(
      ['update', 'send', 'withdraw', 'delete'] as const,
      body.action,
      'action',
    );
    const payload = {
      action,
      ...(action === 'update' ? pick(body, BROADCAST_FIELDS) : {}),
      operator: actorOf(employee),
    };
    const eventName =
      action === 'send'
        ? 'broadcast_sent'
        : action === 'withdraw'
          ? 'broadcast_withdrawn'
          : action === 'delete'
            ? 'broadcast_deleted'
            : 'broadcast_draft_saved';
    return audited(
      employee,
      eventName,
      `notification-broadcast:${id}`,
      { action, request: payload },
      () => portal.send('PATCH', `/broadcasts/${id}`, payload),
      () => portal.get(`/broadcasts/${id}`),
    );
  }

  function sendLogQuery(raw: Record<string, unknown>) {
    const params = new URLSearchParams();
    for (const key of SEND_LOG_FILTERS) {
      const value = raw[key];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string') throw invalid(`${key} is not valid`);
      params.set(key, value);
    }
    const channel = raw.channel;
    if (channel !== undefined && channel !== '')
      params.set('channel', oneOf(NOTIFICATION_CHANNELS, channel, 'channel'));
    return params.toString();
  }

  async function sendLog(raw: Record<string, unknown>) {
    return portal.get(`/send-log?${sendLogQuery(raw)}`);
  }

  /** 日志 ID 由 Portal 生成，格式不在这里约束；只挡住空值、过长和 `.` / `..`。 */
  async function sendLogDetail(rawId: string) {
    if (typeof rawId !== 'string' || rawId.length > 120 || /^\.*$/.test(rawId))
      throw invalid('id is not valid');
    return portal.get(`/send-log/${encodeURIComponent(rawId)}`);
  }

  return {
    templates,
    updateTemplate,
    testTemplate,
    audiences,
    listBroadcasts,
    broadcastDetail,
    createBroadcast,
    patchBroadcast,
    sendLog,
    sendLogDetail,
  };
}
