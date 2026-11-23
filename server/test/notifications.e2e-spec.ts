import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { query } from '../src/backoffice/lib/db';
import {
  ensureEmployee,
  resetRateLimits,
  signInAs,
} from './helpers/employee-session';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

/**
 * Notification Configuration（PRD §3/§11.3、设计 §5）：只有 Admin 角色 + Settings 生效
 * 才能读写代理接口；写操作由 Admin 注入操作人并落 BackOffice 审计；sandbox 能力集下
 * （settings 关闭）不会对外暴露。数据面在 Portal，测试用本地假 Portal 校验令牌与请求。
 */
const TOKEN = 'e2e-notifications-token';

type Captured = {
  method: string;
  path: string;
  token: string | undefined;
  body: Record<string, unknown> | null;
};

function startFakePortal(): Promise<{
  server: Server;
  base: string;
  captured: Captured[];
}> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        token:
          typeof req.headers['x-notifications-token'] === 'string'
            ? req.headers['x-notifications-token']
            : undefined,
        body,
      });
      const path = req.url ?? '';
      const json = (value: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (path.startsWith('/api/integration/notifications/templates')) {
        if (req.method === 'PUT') {
          json({ ok: true, template: { id: 'SUB_SUCCESS' } });
          return;
        }
        json({
          ok: true,
          templates: [
            {
              id: 'SUB_SUCCESS',
              category: 'subscription',
              channels: ['in_app'],
              locked: true,
              enabled: true,
              triggerText: 'A new subscription is paid',
              recipientText: 'The subscriber',
              sendsText: 'Once per order',
              buttonLink: '{{app_url}}/my-learning/subscription',
              en: { title: 'Subscription successful', message: 'Active' },
              zh: { title: '订阅成功', message: '已生效' },
              updatedAt: null,
              updatedBy: null,
              variables: ['plan_name'],
            },
          ],
        });
        return;
      }
      if (path.startsWith('/api/integration/notifications/audiences')) {
        json({ ok: true, all: 12500, paid: 3200 });
        return;
      }
      if (path.startsWith('/api/integration/notifications/broadcasts')) {
        json({ ok: true, broadcasts: [], total: 0, page: 1, pageSize: 20 });
        return;
      }
      if (path.startsWith('/api/integration/notifications/send-log')) {
        json({ ok: true, items: [], total: 0, page: 1, pageSize: 20 });
        return;
      }
      res.statusCode = 404;
      json({ ok: false, code: 'not_found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${address.port}`,
        captured,
      });
    });
  });
}

describe('Notification Configuration access (e2e)', () => {
  let app: INestApplication<App>;
  let portal: Awaited<ReturnType<typeof startFakePortal>>;

  beforeAll(async () => {
    portal = await startFakePortal();
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = portal.base;
    process.env.PORTAL_NOTIFICATIONS_TOKEN = TOKEN;
    delete process.env.ADMIN_CAPABILITIES;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await query(`DELETE FROM employees WHERE login_email LIKE 'e2e-notify-%'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM employees WHERE login_email LIKE 'e2e-notify-%'`);
    await app.close();
    await new Promise<void>((resolve) => portal.server.close(() => resolve()));
    delete process.env.PORTAL_NOTIFICATIONS_BASE_URL;
    delete process.env.PORTAL_NOTIFICATIONS_TOKEN;
  });

  beforeEach(() => resetRateLimits());

  const server = () => app.getHttpServer();

  it('rejects signed-out calls and non-Admin roles', async () => {
    await request(server())
      .get('/api/backoffice/notifications/templates')
      .expect(401);

    const finance = await signInAs(app, 'FINANCE');
    const financeResponse = (await finance
      .get('/api/backoffice/notifications/templates')
      .expect(403)) as ErrorResponse;
    expect(financeResponse.body.error.code).toBe('NOT_AUTHORISED');
    // Every verb is refused, not only reads.
    await finance
      .post('/api/backoffice/notifications/broadcasts')
      .send({ titleEn: 'x', bodyEn: 'y', audience: 'all' })
      .expect(403);
    await finance
      .patch('/api/backoffice/notifications/broadcasts/b1')
      .send({ action: 'send' })
      .expect(403);
    await finance
      .put('/api/backoffice/notifications/templates/SUB_SUCCESS')
      .send({ enabled: true })
      .expect(403);

    const operations = await signInAs(app, 'OPERATION_ADMIN');
    const operationsResponse = (await operations
      .get('/api/backoffice/notifications/templates')
      .expect(403)) as ErrorResponse;
    expect(operationsResponse.body.error.code).toBe('NOT_AUTHORISED');
    // Admin-only is enforced before the proxy: the fake Portal never saw these calls.
    expect(
      portal.captured.filter((call) => call.path.includes('/templates')).length,
    ).toBe(0);
  });

  it('lets Admin read the templates through the service-token proxy', async () => {
    const admin = await signInAs(app, 'ADMIN');
    const response = (await admin
      .get('/api/backoffice/notifications/templates')
      .expect(200)) as SuccessResponse<{ templates: Array<{ id: string }> }>;
    expect(response.body.success).toBe(true);
    expect(response.body.data.templates[0].id).toBe('SUB_SUCCESS');
    const call = portal.captured.find((item) =>
      item.path.includes('/templates'),
    );
    expect(call?.token).toBe(TOKEN);
  });

  it('injects the operator and writes an audit row on template save', async () => {
    const admin = await signInAs(app, 'ADMIN');
    const session = (await admin
      .get('/api/session')
      .expect(200)) as SuccessResponse<{ employee: { employeeId: string } }>;
    const employeeId = session.body.data.employee.employeeId;
    await admin
      .put('/api/backoffice/notifications/templates/SUB_SUCCESS')
      .send({
        enabled: true,
        en: { title: 'Subscription successful', message: 'Active' },
        expectedUpdatedAt: null,
        operator: 'attacker',
      })
      .expect(200);

    const write = portal.captured.find(
      (call) => call.method === 'PUT' && call.path.includes('/templates'),
    );
    expect(write?.body?.operator).toBeTruthy();
    expect(write?.body?.operator).not.toBe('attacker');

    const events = await query<{
      event_name: string;
      actor_employee_id: string;
      action: string;
      old_value: string | null;
      new_value: string | null;
    }>(
      `SELECT event_name, actor_employee_id, action, old_value, new_value
         FROM audit_events
        WHERE actor_employee_id = $1 AND event_name = 'template_saved'
        ORDER BY created_at DESC
        LIMIT 1`,
      [employeeId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('notification-template:SUB_SUCCESS');
    expect(events[0].new_value).toContain('"message":"Active"');
  });
});

describe('Notification Configuration capability gate (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // sandbox 只开 course,accounts：settings 关闭，通知配置不得对外暴露。
    process.env.ADMIN_CAPABILITIES = 'course,accounts';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await ensureEmployee('e2e-notify-sandbox@example.com', 'ADMIN');
  });

  afterAll(async () => {
    await query(
      `DELETE FROM employees WHERE login_email = 'e2e-notify-sandbox@example.com'`,
    );
    await app.close();
    delete process.env.ADMIN_CAPABILITIES;
  });

  it('does not expose Notification Configuration when Settings is disabled', async () => {
    resetRateLimits();
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/sign-in')
      .send({
        email: 'e2e-notify-sandbox@example.com',
        password: 'e2e-password-123',
      })
      .expect(200);
    // The capability gate answers first, like every other governed module: 404, not 403.
    await agent.get('/api/backoffice/notifications/templates').expect(404);
  });
});
