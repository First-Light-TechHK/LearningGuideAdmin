import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { configureApp } from '../../common/app-setup';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  type SessionEmployee,
} from '../contracts/employee';
import {
  createHelpdeskService,
  type HelpdeskService,
} from '../modules/helpdesk/helpdeskService';
import { createPortalHelpdeskClient } from '../modules/helpdesk/portalHelpdeskClient';
import { levelFor } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import { BackofficeModule } from '../nest/backoffice.module';
import {
  BackofficeHelpdeskController,
  HELPDESK_SERVICE,
} from '../nest/helpdesk.controller';
import {
  BackofficeHelpdeskQuestionsController,
  HelpdeskIntegrationQuestionsController,
} from '../nest/helpdesk-questions.controller';
import { HELPDESK_SUGGESTION_STATS } from '../../contracts/helpdesk-qa';

/**
 * HelpDesk Tickets v1 §7：菜单 helpDesk 的 VIEW 只能读，FULL 才能写；
 * 写入的 agent 一律是当前登录员工。会话层 mock 掉（不连数据库），
 * Portal 用 mock fetch，令牌是本地测试值。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const TICKET_ID = '01920000-0000-7000-8000-000000000001';
const TEST_TOKEN = 'test-helpdesk-token-local-only';
const IDEM = '0192ffff-0000-7000-8000-000000000009';

const ticket = {
  id: TICKET_ID,
  number: 'LG-261028-0001',
  subject: 'Help',
  category: 'learning',
  status: 'OPEN',
  learner: { id: 'u1', email: 'l@example.com', name: 'Lena' },
  assignee: null,
  sequence: 1,
  createdAt: '2026-10-28T01:00:00Z',
  updatedAt: '2026-10-28T01:00:00Z',
  lastMessageAt: '2026-10-28T01:00:00Z',
  lastMessageBy: 'learner',
  confirmDueAt: null,
  closedAt: null,
  closeReason: null,
  rating: null,
  locale: 'en-GB',
  messages: [],
  events: [],
};

function employeeFor(role: EmployeeRole): SessionEmployee {
  return {
    employeeId: `emp-${role.toLowerCase()}`,
    loginEmail: `${role.toLowerCase()}@example.com`,
    role,
    displayName: role.toLowerCase(),
    accountStatus: 'ACTIVE',
    emailVerification: 'VERIFIED',
    displayStatus: 'Active',
    isBootstrapAdmin: false,
  };
}

const fetchMock = jest.fn();

type Envelope = {
  success: boolean;
  data: { number?: string; tickets?: { needsReply: boolean }[] };
  error: { code: string };
};

function envelope(res: request.Response): Envelope {
  return res.body as Envelope;
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [BackofficeHelpdeskController],
  providers: [
    {
      provide: HELPDESK_SERVICE,
      useFactory: () =>
        createHelpdeskService(
          createPortalHelpdeskClient({
            fetchImpl: fetchMock as unknown as typeof fetch,
          }),
        ),
    },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class HelpdeskTestModule {}

describe('HelpDesk endpoints: route access and RBAC', () => {
  let app: INestApplication<App>;
  const saved = {
    base: process.env.PORTAL_HELPDESK_BASE_URL,
    token: process.env.PORTAL_HELPDESK_TOKEN,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HelpdeskTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.PORTAL_HELPDESK_BASE_URL = saved.base;
    process.env.PORTAL_HELPDESK_TOKEN = saved.token;
  });

  beforeEach(() => {
    process.env.PORTAL_HELPDESK_BASE_URL = 'http://portal.test';
    process.env.PORTAL_HELPDESK_TOKEN = TEST_TOKEN;
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(ticket), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    (resolveSession as jest.Mock).mockImplementation((token?: string) =>
      Promise.resolve(
        token && (EMPLOYEE_ROLES as readonly string[]).includes(token)
          ? employeeFor(token as EmployeeRole)
          : null,
      ),
    );
  });

  const server = () => app.getHttpServer();
  const as = (role: EmployeeRole) => `lgbo_session=${role}`;
  const message = { body: 'Hello', internal: false, expectedSequence: 1 };

  it('requires a signed-in employee', async () => {
    const res = await request(server())
      .get('/api/helpdesk/tickets')
      .expect(401);
    expect(envelope(res).error.code).toBe('INVALID_EMPLOYEE_ACCOUNT');
    await request(server())
      .post(`/api/helpdesk/tickets/${TICKET_ID}/messages`)
      .send(message)
      .expect(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const viewRoles = EMPLOYEE_ROLES.filter(
    (role) => levelFor(role, 'helpDesk') === 'VIEW',
  );
  const fullRoles = EMPLOYEE_ROLES.filter(
    (role) => levelFor(role, 'helpDesk') === 'FULL',
  );

  it('matches the PRD matrix: Admin and Operation Admin write, the rest only read', () => {
    expect(fullRoles).toEqual(['ADMIN', 'OPERATION_ADMIN']);
    expect(viewRoles).toEqual([
      'COURSE_CREATOR',
      'GRAPHIC_DESIGNER',
      'FINANCE',
      'OPERATION_AI',
    ]);
  });

  it.each(viewRoles)('%s can read the board and a ticket', async (role) => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ tickets: [ticket], nextCursor: null, counts: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const list = await request(server())
      .get('/api/helpdesk/tickets?status=all')
      .set('Cookie', as(role))
      .expect(200);
    expect(envelope(list).success).toBe(true);
    expect(envelope(list).data.tickets?.[0].needsReply).toBe(true);
    const one = await request(server())
      .get(`/api/helpdesk/tickets/${TICKET_ID}`)
      .set('Cookie', as(role))
      .expect(200);
    expect(envelope(one).data.number).toBe('LG-261028-0001');
  });

  it.each(viewRoles)(
    '%s cannot reply, note, claim or propose resolution',
    async (role) => {
      for (const [path, body] of [
        [`/api/helpdesk/tickets/${TICKET_ID}/messages`, message],
        [
          `/api/helpdesk/tickets/${TICKET_ID}/messages`,
          { ...message, internal: true },
        ],
        [
          `/api/helpdesk/tickets/${TICKET_ID}/actions`,
          { action: 'claim', expectedSequence: 1 },
        ],
        [
          `/api/helpdesk/tickets/${TICKET_ID}/actions`,
          { action: 'propose_resolution', expectedSequence: 1 },
        ],
        [
          `/api/helpdesk/tickets/${TICKET_ID}/actions`,
          { action: 'add_tag', tag: 'x', expectedSequence: 1 },
        ],
        [
          `/api/helpdesk/tickets/${TICKET_ID}/actions`,
          { action: 'remove_tag', tag: 'x', expectedSequence: 1 },
        ],
        [`/api/helpdesk/tickets/${TICKET_ID}/actions`, { action: 'mark_read' }],
      ] as const) {
        const res = await request(server())
          .post(path)
          .set('Cookie', as(role))
          .send(body)
          .expect(403);
        expect(envelope(res).error.code).toBe('NOT_AUTHORISED');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(fullRoles)(
    '%s can reply, and Portal receives that employee as agent',
    async (role) => {
      const res = await request(server())
        .post(`/api/helpdesk/tickets/${TICKET_ID}/messages`)
        .set('Cookie', as(role))
        .set('Idempotency-Key', IDEM)
        .send({ ...message, agent: { id: 'forged', name: 'forged' } })
        .expect(200);
      expect(envelope(res).success).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `http://portal.test/api/integration/helpdesk/tickets/${TICKET_ID}/messages`,
      );
      const headers = init.headers as Record<string, string>;
      expect(headers['idempotency-key']).toBe(IDEM);
      expect(headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(
        (JSON.parse(init.body as string) as { agent: unknown }).agent,
      ).toEqual({
        id: `emp-${role.toLowerCase()}`,
        name: role.toLowerCase(),
      });
    },
  );

  it.each(fullRoles)('%s can claim a ticket', async (role) => {
    await request(server())
      .post(`/api/helpdesk/tickets/${TICKET_ID}/actions`)
      .set('Cookie', as(role))
      .send({ action: 'claim', expectedSequence: 1 })
      .expect(200);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'claim',
      agent: { id: `emp-${role.toLowerCase()}`, name: role.toLowerCase() },
      expectedSequence: 1,
    });
  });

  it('answers 503 HELPDESK_NOT_CONNECTED when Portal is not configured', async () => {
    delete process.env.PORTAL_HELPDESK_TOKEN;
    const res = await request(server())
      .get('/api/helpdesk/tickets')
      .set('Cookie', as('ADMIN'))
      .expect(503);
    expect(envelope(res).error.code).toBe('HELPDESK_NOT_CONNECTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a stale-ticket conflict to the browser as 409 STALE_TICKET', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://www.ilovelearningguide.com/problems/stale_ticket',
            title: 'Stale',
            status: 409,
            detail: 'Ticket changed',
            code: 'stale_ticket',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    const res = await request(server())
      .post(`/api/helpdesk/tickets/${TICKET_ID}/actions`)
      .set('Cookie', as('ADMIN'))
      .send({ action: 'propose_resolution', expectedSequence: 1 })
      .expect(409);
    expect(envelope(res).error.code).toBe('STALE_TICKET');
  });

  it('rejects invalid input with 400 INVALID_INPUT', async () => {
    const res = await request(server())
      .post(`/api/helpdesk/tickets/${TICKET_ID}/messages`)
      .set('Cookie', as('ADMIN'))
      .send({ body: '', internal: false, expectedSequence: 1 })
      .expect(400);
    expect(envelope(res).error.code).toBe('INVALID_INPUT');
  });

  describe('attachment proxy', () => {
    it('streams the image with no-store caching for a VIEW role', async () => {
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      );
      const res = await request(server())
        .get('/api/helpdesk/attachments/a1')
        .set('Cookie', as('FINANCE'))
        .expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body as Buffer)).toEqual(
        Buffer.from([137, 80, 78, 71]),
      );
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        'http://portal.test/api/integration/helpdesk/attachments/a1',
      );
    });

    it('serves non-image files as a download with a safe file name', async () => {
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="in\\"voice ä.pdf"',
            },
          }),
        ),
      );
      const res = await request(server())
        .get('/api/helpdesk/attachments/a2')
        .set('Cookie', as('ADMIN'))
        .expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="in_voice _.pdf"; filename*=UTF-8''in%22voice%20%C3%A4.pdf`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves images inline', async () => {
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'content-type': 'image/gif' },
          }),
        ),
      );
      const res = await request(server())
        .get('/api/helpdesk/attachments/a3')
        .set('Cookie', as('ADMIN'))
        .expect(200);
      expect(res.headers['content-disposition']).toBe('inline');
    });

    it('returns the envelope error when Portal has no such attachment', async () => {
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(new Response('{}', { status: 404 })),
      );
      const res = await request(server())
        .get('/api/helpdesk/attachments/a1')
        .set('Cookie', as('ADMIN'))
        .expect(404);
      expect(envelope(res).error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('requires a session', async () => {
      await request(server()).get('/api/helpdesk/attachments/a1').expect(401);
    });
  });
});

describe('BackofficeModule wiring', () => {
  it('registers the HelpDesk controller with a real service (no DB needed to compile)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BackofficeModule],
    }).compile();
    expect(moduleRef.get(BackofficeHelpdeskController)).toBeInstanceOf(
      BackofficeHelpdeskController,
    );
    const service = moduleRef.get<HelpdeskService>(HELPDESK_SERVICE);
    expect(typeof service.list).toBe('function');
    await moduleRef.close();
  });
});

describe('BackofficeModule.register wiring (Common Questions)', () => {
  it('registers the Common Questions and Portal integration controllers with the suggestion counters', async () => {
    const statsFor = jest.fn().mockResolvedValue(new Map());
    const moduleRef = await Test.createTestingModule({
      imports: [
        BackofficeModule.register({
          helpdeskSuggestionStats: {
            provide: HELPDESK_SUGGESTION_STATS,
            useValue: { statsFor },
          },
        }),
      ],
    }).compile();
    expect(moduleRef.get(BackofficeHelpdeskQuestionsController)).toBeInstanceOf(
      BackofficeHelpdeskQuestionsController,
    );
    expect(
      moduleRef.get(HelpdeskIntegrationQuestionsController),
    ).toBeInstanceOf(HelpdeskIntegrationQuestionsController);
    expect(moduleRef.get(BackofficeHelpdeskController)).toBeInstanceOf(
      BackofficeHelpdeskController,
    );
    await moduleRef.close();
  });
});
