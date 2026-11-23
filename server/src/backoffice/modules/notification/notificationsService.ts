import type { SessionEmployee } from '../../contracts/employee';
import type { AuditEventInput } from '../../repositories/auditRepository';
import {
  BROADCAST_LIMITS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_LANGUAGES,
  TEMPLATE_LIMITS,
  type NotificationChannel,
  type NotificationCopy,
  type NotificationLanguage,
  type NotificationTemplate,
} from './contracts';
import {
  NotificationsError,
  type PortalNotificationsClient,
} from './portalNotificationsClient';

/**
 * Notification Configuration 的 Admin 服务：输入校验、操作人注入、BackOffice 审计，
 * 其余事实全部在 Portal（模板、广播、日志、受众）。权限由全局守卫按
 * settings + Admin-only 校验，这里不再判断角色。
 */

const COPY_FIELDS = [
  'title',
  'message',
  'buttonText',
  'subject',
  'emailBody',
  'emailButtonText',
] as const;

const SYSTEM_LINK_VARIABLES = new Set([
  'app_url',
  'ticket_link',
  'course_link',
  'session_link',
]);

/** 常见拼写 → 正确变量（PRD NTF-BO-017 的例子 + 相近写法）。 */
const VARIABLE_ALIASES: Record<string, string> = {
  amount_due: 'renewal_amount',
  renewal_price: 'renewal_amount',
  renewal_cost: 'renewal_amount',
  plan: 'plan_name',
  scope: 'scope_name',
  valid_until: 'valid_to',
  expires_on: 'expired_date',
  expired_on: 'expired_date',
  grace_end: 'grace_end_date',
  due_date: 'renewal_date',
  renewal_on: 'renewal_date',
  ai_point: 'ai_points',
  points: 'ai_points',
  ticket_title: 'ticket_subject',
  course_name: 'course_title',
  category: 'category_name',
  session_name: 'session_title',
  group: 'group_name',
};

function invalid(message: string): NotificationsError {
  return new NotificationsError(400, 'INVALID_INPUT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

function text(
  raw: unknown,
  field: string,
  max: number,
  required = true,
): string {
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`${field} is required`);
    return '';
  }
  if (typeof raw !== 'string') throw invalid(`${field} must be text`);
  const value = raw.trim();
  if (required && value === '') throw invalid(`${field} is required`);
  if (value.length > max) throw invalid(`${field} is too long`);
  return value;
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

/** 拷贝对象：只保留已知字段的字符串值；null/非字符串视为清空。 */
function parseCopy(
  raw: unknown,
  language: NotificationLanguage,
): NotificationCopy {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw invalid(`${language} copy must be an object`);
  const copy: NotificationCopy = {};
  for (const field of COPY_FIELDS) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value === null || value === '') continue;
    if (typeof value !== 'string')
      throw invalid(`${language}.${field} must be text`);
    copy[field] = value;
  }
  return copy;
}

function limitFor(field: (typeof COPY_FIELDS)[number]): number {
  switch (field) {
    case 'title':
      return TEMPLATE_LIMITS.in_app.title;
    case 'message':
      return TEMPLATE_LIMITS.in_app.message;
    case 'buttonText':
      return TEMPLATE_LIMITS.in_app.buttonText;
    case 'subject':
      return TEMPLATE_LIMITS.email.subject;
    case 'emailBody':
      return TEMPLATE_LIMITS.email.emailBody;
    case 'emailButtonText':
      return TEMPLATE_LIMITS.email.emailButtonText;
  }
}

function checkCopyLimits(
  copy: NotificationCopy,
  language: NotificationLanguage,
  fields: readonly (typeof COPY_FIELDS)[number][],
) {
  for (const field of fields) {
    const value = copy[field];
    if (value === undefined) continue;
    const max = limitFor(field);
    if (value.length > max)
      throw invalid(`${language} ${field} must be ${max} characters or fewer`);
  }
}

/** 某语言的必填字段由英文侧存在的字段决定（中文可选，填了就必须填全）。 */
function requiredFields(
  channels: readonly NotificationChannel[],
  en: NotificationCopy,
): Array<(typeof COPY_FIELDS)[number]> {
  const fields: Array<(typeof COPY_FIELDS)[number]> = [];
  if (channels.includes('in_app')) {
    for (const field of ['title', 'message', 'buttonText'] as const)
      if (en[field] !== undefined) fields.push(field);
  }
  if (channels.includes('email')) {
    for (const field of ['subject', 'emailBody', 'emailButtonText'] as const)
      if (en[field] !== undefined) fields.push(field);
  }
  return fields;
}

function checkChineseComplete(
  channels: readonly NotificationChannel[],
  en: NotificationCopy,
  zh: NotificationCopy,
) {
  const anyChinese = COPY_FIELDS.some(
    (field) => (zh[field] ?? '').trim() !== '',
  );
  if (!anyChinese) return;
  const required = requiredFields(channels, en);
  const missing = required.filter((field) => (zh[field] ?? '').trim() === '');
  if (missing.length > 0)
    throw invalid(
      `Chinese is optional, but if any Chinese field is filled, all required fields must be filled (${missing.join(', ')})`,
    );
}

const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function variablesIn(value: string): string[] {
  return [...value.matchAll(VARIABLE)].map((match) => match[1]);
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols));
  for (let i = 0; i < rows; i += 1) table[i][0] = i;
  for (let j = 0; j < cols; j += 1) table[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + cost,
      );
    }
  }
  return table[rows - 1][cols - 1];
}

function suggestVariable(
  unknown: string,
  allowed: readonly string[],
): string | null {
  const alias = VARIABLE_ALIASES[unknown];
  if (alias && allowed.includes(alias)) return alias;
  let best: { name: string; distance: number } | null = null;
  for (const name of allowed) {
    const distance = editDistance(unknown, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best && best.distance <= 3 ? best.name : null;
}

function checkVariables(
  copy: NotificationCopy,
  allowed: readonly string[],
  channels: readonly NotificationChannel[],
) {
  for (const field of COPY_FIELDS) {
    const value = copy[field];
    if (!value) continue;
    for (const name of variablesIn(value)) {
      if (allowed.includes(name)) continue;
      const suggestion = suggestVariable(name, allowed);
      throw invalid(
        suggestion
          ? `{{${name}}} is not available for this notification. Use {{${suggestion}}} instead.`
          : `{{${name}}} is not available for this notification.`,
      );
    }
  }
  void channels;
}

function templateAllowedVariables(template: NotificationTemplate): string[] {
  return (template.variables ?? []).filter(
    (name) => !SYSTEM_LINK_VARIABLES.has(name),
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

  async function findTemplate(id: string): Promise<NotificationTemplate> {
    const result = await templates().catch(() => null);
    const template = result?.templates.find((item) => item.id === id);
    if (!template)
      throw new NotificationsError(404, 'NOT_FOUND', 'Template not found');
    return template;
  }

  async function updateTemplate(
    employee: SessionEmployee,
    rawId: string,
    rawBody: unknown,
  ) {
    const id = text(rawId, 'id', 80);
    const body = record(rawBody);
    const current = await findTemplate(id);
    const hasEn = body.en !== undefined;
    const hasZh = body.zh !== undefined;
    const hasEnabled = body.enabled !== undefined;
    if (!hasEn && !hasZh && !hasEnabled)
      throw invalid('Change at least one field');

    if (hasEnabled && typeof body.enabled !== 'boolean')
      throw invalid('enabled must be true or false');
    if (hasEnabled && body.enabled === false && current.locked)
      throw new NotificationsError(
        400,
        'TEMPLATE_LOCKED',
        'Subscription notifications always stay on',
      );

    const en = hasEn ? parseCopy(body.en, 'en') : undefined;
    const zh = hasZh ? parseCopy(body.zh, 'zh') : undefined;
    const nextEn = en ?? current.en;
    const nextZh = zh ?? current.zh;
    for (const [copy, language] of [
      [nextEn, 'en'],
      [nextZh, 'zh'],
    ] as const) {
      checkCopyLimits(copy, language, [
        'title',
        'message',
        'buttonText',
        'subject',
        'emailBody',
        'emailButtonText',
      ]);
      checkVariables(copy, templateAllowedVariables(current), current.channels);
    }
    // 英文是必填：清空英文必填字段直接拒绝。
    const required = requiredFields(current.channels, current.en);
    const missingEnglish = required.filter(
      (field) => (nextEn[field] ?? '').trim() === '',
    );
    if (missingEnglish.length > 0)
      throw invalid(`English is required (${missingEnglish.join(', ')})`);
    checkChineseComplete(current.channels, nextEn, nextZh);

    let expectedUpdatedAt: string | null | undefined;
    if ('expectedUpdatedAt' in body) {
      if (body.expectedUpdatedAt === null) expectedUpdatedAt = null;
      else if (typeof body.expectedUpdatedAt === 'string')
        expectedUpdatedAt = body.expectedUpdatedAt;
      else throw invalid('expectedUpdatedAt must be text or null');
    }

    const payload = {
      ...(hasEnabled ? { enabled: body.enabled } : {}),
      ...(en !== undefined ? { en } : {}),
      ...(zh !== undefined ? { zh } : {}),
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
      operator: actorOf(employee),
    };
    const eventName =
      hasEnabled && !hasEn && !hasZh ? 'template_toggled' : 'template_saved';
    return audited(
      employee,
      eventName,
      `notification-template:${id}`,
      payload,
      () => portal.send('PUT', `/templates/${encodeURIComponent(id)}`, payload),
      () => Promise.resolve(current),
    );
  }

  async function testTemplate(
    employee: SessionEmployee,
    rawId: string,
    rawBody: unknown,
  ) {
    const id = text(rawId, 'id', 80);
    const body = record(rawBody);
    const channel = oneOf(NOTIFICATION_CHANNELS, body.channel, 'channel');
    const language = oneOf(NOTIFICATION_LANGUAGES, body.language, 'language');
    const current = await findTemplate(id);
    if (!current.channels.includes(channel))
      throw invalid('This notification does not use that channel');
    const copy = record(body.copy);
    const en = copy.en !== undefined ? parseCopy(copy.en, 'en') : undefined;
    const zh = copy.zh !== undefined ? parseCopy(copy.zh, 'zh') : undefined;
    const allowed = templateAllowedVariables(current);
    for (const [draft, language] of [
      [en, 'en'],
      [zh, 'zh'],
    ] as const) {
      if (!draft) continue;
      checkCopyLimits(draft, language, [
        'title',
        'message',
        'buttonText',
        'subject',
        'emailBody',
        'emailButtonText',
      ]);
      checkVariables(draft, allowed, current.channels);
    }
    const payload = {
      channel,
      language,
      operatorEmail: employee.loginEmail,
      operator: actorOf(employee),
      ...(en || zh
        ? { copy: { ...(en ? { en } : {}), ...(zh ? { zh } : {}) } }
        : {}),
    };
    return audited(
      employee,
      'test_sent',
      `notification-template:${id}`,
      { channel, language },
      () =>
        portal.send(
          'POST',
          `/templates/${encodeURIComponent(id)}/test`,
          payload,
        ),
      () => Promise.resolve(current),
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
    return portal.get(
      `/broadcasts/${encodeURIComponent(text(rawId, 'id', 80))}`,
    );
  }

  function checkButtonPair(
    buttonText: unknown,
    buttonLink: unknown,
    provided: { text: boolean; link: boolean },
  ) {
    const hasText =
      provided.text &&
      typeof buttonText === 'string' &&
      buttonText.trim() !== '';
    const hasLink =
      provided.link &&
      typeof buttonLink === 'string' &&
      buttonLink.trim() !== '';
    if (hasText !== hasLink)
      throw invalid('Button text and button link must be provided together');
    if (hasText) {
      const link = text(buttonLink, 'buttonLink', 500);
      if (!link.startsWith('https://') && !link.startsWith('/'))
        throw invalid('Button link must start with https:// or /');
      text(buttonText, 'buttonText', BROADCAST_LIMITS.buttonText);
    }
  }

  async function createBroadcast(employee: SessionEmployee, rawBody: unknown) {
    const body = record(rawBody);
    const titleEn = text(body.titleEn, 'titleEn', BROADCAST_LIMITS.title);
    const bodyEn = text(body.bodyEn, 'bodyEn', BROADCAST_LIMITS.body);
    const titleZh =
      body.titleZh === undefined || body.titleZh === null || body.titleZh === ''
        ? null
        : text(body.titleZh, 'titleZh', BROADCAST_LIMITS.title);
    const bodyZh =
      body.bodyZh === undefined || body.bodyZh === null || body.bodyZh === ''
        ? null
        : text(body.bodyZh, 'bodyZh', BROADCAST_LIMITS.body);
    const audience = oneOf(['all', 'paid'] as const, body.audience, 'audience');
    checkButtonPair(body.buttonText, body.buttonLink, {
      text: 'buttonText' in body,
      link: 'buttonLink' in body,
    });
    const hasText =
      typeof body.buttonText === 'string' && body.buttonText.trim() !== '';
    const payload = {
      titleEn,
      bodyEn,
      titleZh,
      bodyZh,
      buttonText: hasText
        ? text(body.buttonText, 'buttonText', BROADCAST_LIMITS.buttonText)
        : null,
      buttonLink: hasText ? text(body.buttonLink, 'buttonLink', 500) : null,
      audience,
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
    const id = text(rawId, 'id', 80);
    const body = record(rawBody);
    const action = oneOf(
      ['update', 'send', 'withdraw', 'delete'] as const,
      body.action,
      'action',
    );
    const payload: Record<string, unknown> = {
      action,
      operator: actorOf(employee),
    };
    if (action === 'update') {
      if (body.titleEn !== undefined)
        payload.titleEn = text(body.titleEn, 'titleEn', BROADCAST_LIMITS.title);
      if (body.bodyEn !== undefined)
        payload.bodyEn = text(body.bodyEn, 'bodyEn', BROADCAST_LIMITS.body);
      if ('titleZh' in body)
        payload.titleZh =
          body.titleZh === null || body.titleZh === ''
            ? null
            : text(body.titleZh, 'titleZh', BROADCAST_LIMITS.title);
      if ('bodyZh' in body)
        payload.bodyZh =
          body.bodyZh === null || body.bodyZh === ''
            ? null
            : text(body.bodyZh, 'bodyZh', BROADCAST_LIMITS.body);
      if (body.audience !== undefined)
        payload.audience = oneOf(
          ['all', 'paid'] as const,
          body.audience,
          'audience',
        );
      if ('buttonText' in body || 'buttonLink' in body) {
        checkButtonPair(body.buttonText, body.buttonLink, {
          text: 'buttonText' in body,
          link: 'buttonLink' in body,
        });
        const hasText =
          typeof body.buttonText === 'string' && body.buttonText.trim() !== '';
        payload.buttonText = hasText
          ? text(body.buttonText, 'buttonText', BROADCAST_LIMITS.buttonText)
          : null;
        payload.buttonLink = hasText
          ? text(body.buttonLink, 'buttonLink', 500)
          : null;
      }
    }
    const eventName =
      action === 'send'
        ? 'broadcast_sent'
        : action === 'withdraw'
          ? 'broadcast_withdrawn'
          : action === 'delete'
            ? 'broadcast_deleted'
            : 'broadcast_draft_saved';
    const before = await portal
      .get(`/broadcasts/${encodeURIComponent(id)}`)
      .catch(() => undefined);
    return audited(
      employee,
      eventName,
      `notification-broadcast:${id}`,
      { action, request: payload },
      () =>
        portal.send('PATCH', `/broadcasts/${encodeURIComponent(id)}`, payload),
      () => Promise.resolve(before),
    );
  }

  function sendLogQuery(raw: Record<string, unknown>) {
    const params = new URLSearchParams();
    const add = (key: string, value: unknown, max: number) => {
      if (value === undefined || value === '') return;
      if (typeof value !== 'string') throw invalid(`${key} is not valid`);
      params.set(key, text(value, key, max, false));
    };
    add('recipient', raw.recipient, 254);
    add('template', raw.template, 80);
    add('broadcast', raw.broadcast, 80);
    const channel = raw.channel;
    if (channel !== undefined && channel !== '') {
      if (
        typeof channel !== 'string' ||
        !(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)
      )
        throw invalid('channel is not valid');
      params.set('channel', channel);
    }
    const status = raw.status;
    if (status !== undefined && status !== '') {
      const allowed = ['delivered', 'read', 'withdrawn', 'sent', 'failed'];
      if (typeof status !== 'string' || !allowed.includes(status))
        throw invalid('status is not valid');
      params.set('status', status);
    }
    add('from', raw.from, 40);
    add('to', raw.to, 40);
    const page = Number(raw.page ?? '1');
    if (!Number.isInteger(page) || page < 1)
      throw invalid('page must be a positive integer');
    params.set('page', String(page));
    return params.toString();
  }

  async function sendLog(raw: Record<string, unknown>) {
    return portal.get(`/send-log?${sendLogQuery(raw)}`);
  }

  async function sendLogDetail(rawId: string) {
    return portal.get(
      `/send-log/${encodeURIComponent(text(rawId, 'id', 120))}`,
    );
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
