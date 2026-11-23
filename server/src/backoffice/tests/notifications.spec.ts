import assert from 'node:assert/strict';

import type { SessionEmployee } from '../contracts/employee';
import type { AuditEventInput } from '../repositories/auditRepository';
import { courseLaunchEventParams } from '../../commerce-courses/publishing.service';
import { visibleReplyEventFor } from '../modules/helpdesk/helpdeskService';
import type { EnquiryDetail } from '../modules/helpdesk/contracts';
import { NOTIFICATIONS_SERVICE } from '../nest/notifications.controller';
import { routeAccess } from '../nest/route-access';
import {
  courseLaunchEventKey,
  emitNotificationEvent,
  notifyHelpdeskReply,
  ticketReplyEventKey,
} from '../modules/notification/events';
import { createNotificationsService } from '../modules/notification/notificationsService';
import {
  createPortalNotificationsClient,
  NotificationsError,
  type PortalNotificationsClient,
} from '../modules/notification/portalNotificationsClient';
import type { NotificationTemplate } from '../modules/notification/contracts';

/**
 * Notification P0（设计 §3/§5）：路由归类与 Admin-only、Portal 客户端错误映射、
 * 模板/广播校验与审计、事件幂等键与失败不阻塞。
 */

const employee: SessionEmployee = {
  employeeId: 'emp-notify',
  loginEmail: 'jack@example.com',
  role: 'ADMIN',
  displayName: 'Jack',
  accountStatus: 'ACTIVE',
  emailVerification: 'VERIFIED',
  displayStatus: 'Active',
  isBootstrapAdmin: false,
};

const template: NotificationTemplate = {
  id: 'SUB_RENEWAL_REMINDER',
  category: 'subscription',
  channels: ['in_app', 'email'],
  locked: true,
  enabled: true,
  triggerText: '5 days before the subscription end date',
  recipientText: 'The subscriber',
  sendsText: 'Once per billing period',
  buttonLink: '{{app_url}}/my-learning/subscription',
  en: {
    title: 'Your subscription renews soon',
    message: 'Your {{plan_name}} renews for {{renewal_amount}}.',
    buttonText: 'Manage subscription',
    subject: 'Renews soon',
    emailBody: 'Hi {{user_name}}, your {{plan_name}} renews.',
    emailButtonText: 'Manage subscription',
  },
  zh: {
    title: '你的订阅即将续费',
    message: '你的{{plan_name}}将续费 {{renewal_amount}}。',
    buttonText: '管理订阅',
    subject: '即将续费',
    emailBody: '你好 {{user_name}}，你的{{plan_name}}将续费。',
    emailButtonText: '管理订阅',
  },
  updatedAt: '2026-11-02T06:20:00.000Z',
  updatedBy: 'Jack',
  variables: ['plan_name', 'renewal_amount', 'renewal_date', 'user_name'],
};

function fakePortal(overrides: Partial<PortalNotificationsClient> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const portal: PortalNotificationsClient = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve({
        ok: true,
        templates: [template],
        all: 12500,
        paid: 3200,
      });
    },
    send: (method, path, body) => {
      calls.push({ method, path, body });
      return Promise.resolve({
        ok: true,
        template: {},
        broadcast: { id: 'b1' },
      });
    },
    ...overrides,
  };
  return { portal, calls };
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  return {
    events,
    audit: (event: AuditEventInput) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

describe('notification route access', () => {
  it('maps every /api/backoffice/notifications route to the Settings menu, Admin only', () => {
    const cases: Array<[string, string, string]> = [
      ['GET', '/api/backoffice/notifications/templates', 'VIEW'],
      ['PUT', '/api/backoffice/notifications/templates/SUB_SUCCESS', 'PUBLISH'],
      [
        'POST',
        '/api/backoffice/notifications/templates/SUB_SUCCESS/test',
        'PUBLISH',
      ],
      ['GET', '/api/backoffice/notifications/audiences', 'VIEW'],
      ['GET', '/api/backoffice/notifications/broadcasts?page=1', 'VIEW'],
      ['POST', '/api/backoffice/notifications/broadcasts', 'PUBLISH'],
      ['PATCH', '/api/backoffice/notifications/broadcasts/b1', 'PUBLISH'],
      ['GET', '/api/backoffice/notifications/send-log', 'VIEW'],
      ['GET', '/api/backoffice/notifications/send-log/log-1', 'VIEW'],
    ];
    for (const [method, path, action] of cases) {
      assert.deepEqual(routeAccess(method, path), {
        kind: 'menu',
        menus: ['settings'],
        action,
        adminOnly: true,
      });
    }
  });

  it('keeps other unregistered backoffice paths Admin-only instead of Settings', () => {
    assert.deepEqual(routeAccess('GET', '/api/backoffice/other'), {
      kind: 'employeeAdmin',
    });
  });
});

describe('Portal notifications client', () => {
  const original = {
    base: process.env.PORTAL_NOTIFICATIONS_BASE_URL,
    token: process.env.PORTAL_NOTIFICATIONS_TOKEN,
  };

  afterEach(() => {
    if (original.base === undefined)
      delete process.env.PORTAL_NOTIFICATIONS_BASE_URL;
    else process.env.PORTAL_NOTIFICATIONS_BASE_URL = original.base;
    if (original.token === undefined)
      delete process.env.PORTAL_NOTIFICATIONS_TOKEN;
    else process.env.PORTAL_NOTIFICATIONS_TOKEN = original.token;
  });

  it('returns 503 without sending when the token or base URL is missing', async () => {
    delete process.env.PORTAL_NOTIFICATIONS_BASE_URL;
    delete process.env.PORTAL_NOTIFICATIONS_TOKEN;
    let calls = 0;
    const client = createPortalNotificationsClient({
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    await assert.rejects(
      () => client.get('/templates'),
      (error: unknown) =>
        error instanceof NotificationsError &&
        error.status === 503 &&
        error.code === 'NOTIFICATIONS_NOT_CONNECTED',
    );
    assert.equal(calls, 0);
  });

  it('sends X-Notifications-Token and maps a stale template to 409 TEMPLATE_CONFLICT', async () => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'service-token';
    let seen: { url: string; init?: RequestInit } | null = null;
    const client = createPortalNotificationsClient({
      fetchImpl: ((url: string, init?: RequestInit) => {
        seen = { url, init };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              code: 'conflict',
              error: 'Template changed',
              current: { updatedAt: '2026-11-03T00:00:00.000Z' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as typeof fetch,
    });
    await assert.rejects(
      () =>
        client.send('PUT', '/templates/SUB_SUCCESS', {
          enabled: true,
          operator: 'Jack',
        }),
      (error: unknown) =>
        error instanceof NotificationsError &&
        error.status === 409 &&
        error.code === 'TEMPLATE_CONFLICT' &&
        (error.details?.current as { updatedAt?: string })?.updatedAt ===
          '2026-11-03T00:00:00.000Z',
    );
    assert.equal(
      (seen as unknown as { url: string }).url,
      'https://portal.example.com/api/integration/notifications/templates/SUB_SUCCESS',
    );
    assert.equal(
      (
        (seen as unknown as { init: RequestInit }).init.headers as Record<
          string,
          string
        >
      )['x-notifications-token'],
      'service-token',
    );
  });

  it('treats a rejected service token as not connected', async () => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'wrong';
    const client = createPortalNotificationsClient({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false }), { status: 401 }),
        ),
    });
    await assert.rejects(
      () => client.get('/templates'),
      (error: unknown) =>
        error instanceof NotificationsError &&
        error.code === 'NOTIFICATIONS_NOT_CONNECTED',
    );
  });
});

describe('notification service', () => {
  const savedEnv = {
    base: process.env.PORTAL_NOTIFICATIONS_BASE_URL,
    token: process.env.PORTAL_NOTIFICATIONS_TOKEN,
  };
  afterEach(() => {
    for (const [name, value] of [
      ['PORTAL_NOTIFICATIONS_BASE_URL', savedEnv.base],
      ['PORTAL_NOTIFICATIONS_TOKEN', savedEnv.token],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** The real client over a fake Portal that answers every request with `status` and `body`. */
  function serviceOverPortal(status: number, body: unknown) {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'service-token';
    const fetches: string[] = [];
    const portal = createPortalNotificationsClient({
      fetchImpl: ((url: string) => {
        fetches.push(url);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });
    const { events, audit } = fakeAudit();
    return {
      service: createNotificationsService({ portal, audit }),
      fetches,
      events,
    };
  }

  it('passes a Portal validation_failed message through as 400 INVALID_INPUT (NTF-BO-017)', async () => {
    const message =
      'Unknown variable {{amount_due}}. Use {{renewal_amount}} instead.';
    const { service } = serviceOverPortal(400, {
      ok: false,
      code: 'validation_failed',
      error: message,
      issues: [{ field: 'en.message', message }],
    });
    await assert.rejects(
      () =>
        service.updateTemplate(employee, template.id, {
          en: { ...template.en, message: 'Payment of {{amount_due}} failed.' },
        }),
      (error: unknown) =>
        error instanceof NotificationsError &&
        error.status === 400 &&
        error.code === 'INVALID_INPUT' &&
        error.message === message &&
        Array.isArray(error.details?.issues),
    );
  });

  it('passes a Portal locked answer through as 400 TEMPLATE_LOCKED', async () => {
    const { service } = serviceOverPortal(400, {
      ok: false,
      code: 'locked',
      error: 'Subscription notifications always stay on',
    });
    await assert.rejects(
      () => service.updateTemplate(employee, template.id, { enabled: false }),
      (error: unknown) =>
        error instanceof NotificationsError &&
        error.status === 400 &&
        error.code === 'TEMPLATE_LOCKED',
    );
  });

  it('rejects an id with a path in it before any request is made', async () => {
    const { service, fetches } = serviceOverPortal(200, { ok: true });
    for (const id of ['..', 'a/b', '', 'x'.repeat(81)]) {
      for (const call of [
        () => service.updateTemplate(employee, id, { enabled: true }),
        () =>
          service.testTemplate(employee, id, {
            channel: 'email',
            language: 'en',
          }),
        () => service.patchBroadcast(employee, id, { action: 'send' }),
        () => service.broadcastDetail(id),
      ]) {
        await assert.rejects(
          call,
          (error: unknown) =>
            error instanceof NotificationsError &&
            error.status === 400 &&
            error.code === 'INVALID_INPUT',
        );
      }
    }
    await assert.rejects(() => service.sendLogDetail('..'));
    assert.deepEqual(fetches, []);
  });

  it('ignores an operator sent in the body and uses the signed-in employee', async () => {
    const { portal, calls } = fakePortal();
    const { audit } = fakeAudit();
    const service = createNotificationsService({ portal, audit });
    await service.updateTemplate(employee, template.id, {
      enabled: true,
      operator: 'mallory',
    });
    await service.createBroadcast(employee, {
      titleEn: 'Hello',
      bodyEn: 'World',
      audience: 'all',
      operator: 'mallory',
    });
    for (const write of calls.filter((call) => call.method !== 'GET'))
      assert.equal((write.body as { operator?: string }).operator, 'Jack');
  });

  it('injects the operator and records before/after for a template save', async () => {
    const { portal, calls } = fakePortal();
    const { events, audit } = fakeAudit();
    const service = createNotificationsService({ portal, audit });
    await service.updateTemplate(employee, template.id, {
      en: { ...template.en, title: 'Renewals are coming' },
      expectedUpdatedAt: template.updatedAt,
    });
    const write = calls.find((call) => call.method === 'PUT');
    assert.ok(write);
    assert.equal((write?.body as { operator?: string }).operator, 'Jack');
    assert.equal(
      (write?.body as { expectedUpdatedAt?: string }).expectedUpdatedAt,
      template.updatedAt,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].eventName, 'template_saved');
    assert.equal(events[0].actorEmployeeId, employee.employeeId);
    assert.ok(events[0].oldValue?.includes(template.en.title ?? ''));
    assert.ok(events[0].newValue?.includes('Renewals are coming'));
  });

  it('records a switch change as template_toggled even with expectedUpdatedAt', async () => {
    const unlocked = { ...template, locked: false };
    const { portal } = fakePortal({
      get: () =>
        Promise.resolve({ ok: true, templates: [unlocked] } as Record<
          string,
          unknown
        >),
    });
    const { events, audit } = fakeAudit();
    const service = createNotificationsService({ portal, audit });
    await service.updateTemplate(employee, template.id, {
      enabled: false,
      expectedUpdatedAt: template.updatedAt,
    });
    assert.equal(events[0].eventName, 'template_toggled');
  });

  it('sends a test with the operator email from the session, never the request', async () => {
    const { portal, calls } = fakePortal();
    const { events, audit } = fakeAudit();
    const service = createNotificationsService({ portal, audit });
    await service.testTemplate(employee, template.id, {
      channel: 'email',
      language: 'zh',
      operatorEmail: 'attacker@example.com',
    });
    const test = calls.find((call) => call.path.endsWith('/test'));
    assert.ok(test);
    assert.equal(
      (test?.body as { operatorEmail?: string }).operatorEmail,
      'jack@example.com',
    );
    assert.equal((test?.body as { operator?: string }).operator, 'Jack');
    assert.equal(events[0].eventName, 'test_sent');
  });

  it('records broadcast_sent and injects the operator', async () => {
    const { portal, calls } = fakePortal();
    const { events, audit } = fakeAudit();
    const service = createNotificationsService({ portal, audit });
    await service.patchBroadcast(employee, 'b1', { action: 'send' });
    const write = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(write?.body, { action: 'send', operator: 'Jack' });
    assert.equal(events[0].eventName, 'broadcast_sent');
    assert.equal(events[0].action, 'notification-broadcast:b1');
  });

  it('serves the templates service under the notification injection token', () => {
    assert.equal(NOTIFICATIONS_SERVICE.description, 'NOTIFICATIONS_SERVICE');
  });
});

describe('notification event hooks', () => {
  it('maps a first-published course to COURSE_NEW_LAUNCH params (title/category/deep link)', () => {
    assert.deepEqual(
      courseLaunchEventParams({
        code: 'C001',
        slug: 'renaissance-in-florence',
        defaultContentLanguage: 'en-GB',
        localizations: [
          { language: 'zh-CN', title: '佛罗伦萨的文艺复兴' },
          { language: 'en-GB', title: 'The Renaissance in Florence' },
        ],
        category: {
          name: 'Art & Humanities',
          localized: {
            'en-GB': { name: 'Art & Humanities' },
            'zh-CN': { name: '艺术与人文' },
          },
        },
      }),
      {
        courseTitle: 'The Renaissance in Florence',
        categoryName: 'Art & Humanities',
        courseLink: '/en-GB/portal/courses/renaissance-in-florence',
      },
    );
  });

  it('falls back to the course code and category key when localized copy is missing', () => {
    assert.deepEqual(
      courseLaunchEventParams({
        code: 'C002',
        slug: 'no-title',
        defaultContentLanguage: null,
        localizations: [],
        category: { name: 'Society', localized: {} },
      }),
      {
        courseTitle: 'C002',
        categoryName: 'Society',
        courseLink: '/en-GB/portal/courses/no-title',
      },
    );
  });

  function detail(messages: EnquiryDetail['messages']): EnquiryDetail {
    return {
      id: 't9',
      subject: "Can't play the video in Lesson 3",
      student: {
        id: 'u1',
        name: 'Margaret',
        accountEmail: 'margaret@example.com',
        contactEmail: null,
        joinedAt: null,
        totalEnquiries: null,
        currentCourse: null,
      },
      messages,
    } as unknown as EnquiryDetail;
  }

  it('emits HELPDESK_TICKET_REPLIED only for learner-visible agent replies', () => {
    const visible = visibleReplyEventFor(
      detail([
        {
          id: 'm1',
          authorKind: 'learner',
          authorName: 'Margaret',
          body: 'Help',
          internal: false,
          attachments: [],
          createdAt: '2026-11-23T01:00:00.000Z',
        },
        {
          id: 'm2',
          authorKind: 'agent',
          authorName: 'Jack',
          body: 'Here is the fix',
          internal: false,
          attachments: [],
          createdAt: '2026-11-23T02:00:00.000Z',
        },
      ]),
    );
    assert.deepEqual(visible, {
      ticketId: 't9',
      replyId: 'm2',
      ticketSubject: "Can't play the video in Lesson 3",
      ticketLink: '/en-GB/account/my-learning/support/t9',
      email: 'margaret@example.com',
    });

    const internalOnly = visibleReplyEventFor(
      detail([
        {
          id: 'm3',
          authorKind: 'agent',
          authorName: 'Jack',
          body: 'Internal note',
          internal: true,
          attachments: [],
          createdAt: '2026-11-23T03:00:00.000Z',
        },
      ]),
    );
    assert.equal(internalOnly, null);
  });
});

describe('notification events', () => {
  const original = {
    base: process.env.PORTAL_NOTIFICATIONS_BASE_URL,
    token: process.env.PORTAL_NOTIFICATIONS_TOKEN,
  };

  afterEach(() => {
    if (original.base === undefined)
      delete process.env.PORTAL_NOTIFICATIONS_BASE_URL;
    else process.env.PORTAL_NOTIFICATIONS_BASE_URL = original.base;
    if (original.token === undefined)
      delete process.env.PORTAL_NOTIFICATIONS_TOKEN;
    else process.env.PORTAL_NOTIFICATIONS_TOKEN = original.token;
  });

  it('uses course+version and ticket+reply event keys', () => {
    assert.equal(courseLaunchEventKey('c1', 'v3'), 'course:c1:v3');
    assert.equal(ticketReplyEventKey('t9', 'm4'), 'ticket:t9:m4');
  });

  it('posts the service token and event payload', async () => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'service-token';
    let seen: { url: string; init?: RequestInit } | null = null;
    const ok = await emitNotificationEvent(
      {
        eventType: 'COURSE_NEW_LAUNCH',
        eventKey: 'course:c1:v3',
        params: { course_title: 'Florence' },
      },
      {
        fetchImpl: ((url: string, init?: RequestInit) => {
          seen = { url, init };
          return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        }) as typeof fetch,
      },
    );
    assert.equal(ok, true);
    assert.equal(
      (seen as unknown as { url: string }).url,
      'https://portal.example.com/api/integration/notifications/events',
    );
    const init = (seen as unknown as { init: RequestInit }).init;
    assert.equal(
      (init.headers as Record<string, string>)['x-notifications-token'],
      'service-token',
    );
    const body = typeof init.body === 'string' ? init.body : '';
    assert.match(body, /course:c1:v3/);
  });

  it('sends the learner account email with a ticket reply event', async () => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'service-token';
    const captured: { body?: Record<string, unknown> } = {};
    await notifyHelpdeskReply(
      {
        ticketId: 't9',
        replyId: 'm2',
        ticketSubject: 'Video',
        ticketLink: '/en-GB/account/my-learning/support/t9',
        email: 'margaret@example.com',
      },
      {
        fetchImpl: ((_url: string, init?: RequestInit) => {
          captured.body =
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined;
          return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        }) as typeof fetch,
      },
    );
    assert.equal(captured.body?.eventType, 'HELPDESK_TICKET_REPLIED');
    assert.equal(captured.body?.eventKey, 'ticket:t9:m2');
    assert.equal(captured.body?.email, 'margaret@example.com');
  });

  it('returns false (never throws) when notifications are not configured', async () => {
    delete process.env.PORTAL_NOTIFICATIONS_BASE_URL;
    delete process.env.PORTAL_NOTIFICATIONS_TOKEN;
    let calls = 0;
    const ok = await emitNotificationEvent(
      { eventType: 'COURSE_NEW_LAUNCH', eventKey: 'course:c1:v3' },
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response('{}'));
        },
      },
    );
    assert.equal(ok, false);
    assert.equal(calls, 0);
  });

  it('returns false when Portal is unreachable, so the main flow continues', async () => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'https://portal.example.com';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'service-token';
    const ok = await emitNotificationEvent(
      { eventType: 'HELPDESK_TICKET_REPLIED', eventKey: 'ticket:t9:m4' },
      {
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    );
    assert.equal(ok, false);
  });
});
