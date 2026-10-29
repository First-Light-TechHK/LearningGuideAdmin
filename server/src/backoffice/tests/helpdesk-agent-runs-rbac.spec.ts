import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { createMemoryAgentEventLog } from '../../ai/helpdesk/trace/agent-event.store';
import { RunTrace } from '../../ai/helpdesk/trace/run-trace';
import { createTraceSource } from '../../ai/helpdesk/trace/trace-query';
import { configureApp } from '../../common/app-setup';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { HELPDESK_TRACE_SOURCE } from '../../contracts/helpdesk-trace';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  type SessionEmployee,
} from '../contracts/employee';
import { levelFor } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import { BackofficeModule } from '../nest/backoffice.module';
import { BackofficeHelpdeskAgentRunsController } from '../nest/helpdesk-agent-runs.controller';

/**
 * 「查看链路」的读接口（helpdesk-agent-v2-pi-dsh §2）：
 * - GET /api/helpdesk/agent-runs/:runId → { runId, parentRunId, chain, events }
 * - GET /api/helpdesk/agent-runs/:runId/events/:seq → { event, sources, derived }
 * 菜单 helpDesk 的 VIEW 及以上可读；只读，没有写接口；给的是导出副本（学员原文已脱敏）。
 * 会话层 mock 掉，链路源用内存日志（经契约 HelpdeskTraceSource 注入）。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const RUN = '0192eeee-0000-7000-8000-0000000000a1';
const ROOT = '0192eeee-0000-7000-8000-0000000000a0';
const MISSING = '0192eeee-0000-7000-8000-0000000000ff';

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

const log = createMemoryAgentEventLog();

async function seed() {
  let now = Date.UTC(2026, 9, 29, 9, 0, 0);
  for (const [runId, parentRunId] of [
    [ROOT, null],
    [RUN, ROOT],
  ] as const) {
    const trace = new RunTrace(runId, log, () => (now += 5));
    trace.emit('turn/start', {
      turn: 1,
      parentRunId,
      input: { subject: 'Login', message: 'my email is lena@example.com' },
    });
    const step = trace.nextStep();
    trace.emit('step/start', { turn: 1, step, name: 'pick_faq' });
    trace.emit('assistant/message', {
      turn: 1,
      step,
      text: 'lena@example.com',
      usage: { inputTokens: 120, outputTokens: 8 },
      costUsd: 0.00002,
    });
    trace.emit('step/end', { turn: 1, step, name: 'pick_faq' });
    trace.emit('turn/end', { turn: 1, reason: 'no_match' });
    await trace.flush();
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [BackofficeHelpdeskAgentRunsController],
  providers: [
    { provide: HELPDESK_TRACE_SOURCE, useValue: createTraceSource(log) },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class AgentRunsTestModule {}

type Envelope<T> = {
  success: boolean;
  data: T;
  error: { code: string } | null;
};

describe('HelpDesk agent run trace endpoints', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await seed();
    const moduleRef = await Test.createTestingModule({
      imports: [AgentRunsTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
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

  it('requires a signed-in employee', async () => {
    const res = await request(server())
      .get(`/api/helpdesk/agent-runs/${RUN}`)
      .expect(401);
    expect((res.body as Envelope<null>).error?.code).toBe(
      'INVALID_EMPLOYEE_ACCOUNT',
    );
    await request(server())
      .get(`/api/helpdesk/agent-runs/${RUN}/events/1`)
      .expect(401);
  });

  // every role has at least VIEW on the HelpDesk menu (PRD matrix)
  const readers = EMPLOYEE_ROLES.filter(
    (role) => levelFor(role, 'helpDesk') !== 'NONE',
  );

  it('is open to every role with HelpDesk VIEW or FULL', () => {
    expect(readers).toEqual([...EMPLOYEE_ROLES]);
  });

  it.each(readers)('%s can read a run with its chain', async (role) => {
    const res = await request(server())
      .get(`/api/helpdesk/agent-runs/${RUN}`)
      .set('Cookie', as(role))
      .expect(200);
    const body = res.body as Envelope<{
      runId: string;
      parentRunId: string | null;
      chain: string[];
      events: { runId: string; seq: number; type: string }[];
    }>;
    expect(body.success).toBe(true);
    expect(body.data.runId).toBe(RUN);
    expect(body.data.parentRunId).toBe(ROOT);
    expect(body.data.chain).toEqual([ROOT, RUN]);
    expect(body.data.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'turn/start'],
      [2, 'step/start'],
      [3, 'assistant/message'],
      [4, 'step/end'],
      [5, 'turn/end'],
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(readers)('%s can trace one event', async (role) => {
    const res = await request(server())
      .get(`/api/helpdesk/agent-runs/${RUN}/events/3`)
      .set('Cookie', as(role))
      .expect(200);
    const body = res.body as Envelope<{
      event: { seq: number; type: string };
      sources: { seq: number }[];
      derived: { seq: number }[];
    }>;
    expect(body.data.event).toMatchObject({
      seq: 3,
      type: 'assistant/message',
    });
    expect(body.data.sources.map((e) => e.seq)).toEqual([1, 2]);
    expect(body.data.derived.map((e) => e.seq)).toEqual([4]);
  });

  it('never returns learner text', async () => {
    for (const path of [
      `/api/helpdesk/agent-runs/${RUN}`,
      `/api/helpdesk/agent-runs/${RUN}/events/1`,
      `/api/helpdesk/agent-runs/${RUN}/events/3`,
    ]) {
      const res = await request(server())
        .get(path)
        .set('Cookie', as('ADMIN'))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('lena@example.com');
      expect(JSON.stringify(res.body)).toContain('"redacted":true');
    }
  });

  it('accepts an upper-case run id', async () => {
    const res = await request(server())
      .get(`/api/helpdesk/agent-runs/${RUN.toUpperCase()}`)
      .set('Cookie', as('FINANCE'))
      .expect(200);
    expect((res.body as Envelope<{ runId: string }>).data.runId).toBe(RUN);
  });

  it.each([
    [
      'an unknown run',
      `/api/helpdesk/agent-runs/${MISSING}`,
      'AGENT_RUN_NOT_FOUND',
    ],
    [
      'a malformed run id',
      '/api/helpdesk/agent-runs/not-a-uuid',
      'AGENT_RUN_NOT_FOUND',
    ],
    [
      'an unknown event',
      `/api/helpdesk/agent-runs/${RUN}/events/99`,
      'AGENT_EVENT_NOT_FOUND',
    ],
    [
      'an event of an unknown run',
      `/api/helpdesk/agent-runs/${MISSING}/events/1`,
      'AGENT_EVENT_NOT_FOUND',
    ],
  ])('answers 404 for %s', async (_name, path, code) => {
    const res = await request(server())
      .get(path)
      .set('Cookie', as('OPERATION_AI'))
      .expect(404);
    expect((res.body as Envelope<null>).error?.code).toBe(code);
  });

  it.each(['0', '-1', '1.5', 'abc', '1e2', '99999999999'])(
    'rejects seq %s with 400 INVALID_INPUT',
    async (seq) => {
      const res = await request(server())
        .get(`/api/helpdesk/agent-runs/${RUN}/events/${seq}`)
        .set('Cookie', as('ADMIN'))
        .expect(400);
      expect((res.body as Envelope<null>).error?.code).toBe('INVALID_INPUT');
    },
  );

  it('has no write path for any role', async () => {
    for (const role of ['FINANCE', 'ADMIN'] as const) {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        await request(server())
          [method](`/api/helpdesk/agent-runs/${RUN}`)
          .set('Cookie', as(role))
          .send({})
          .expect(404);
      }
    }
    // the log itself is untouched by reads
    expect((await log.read(RUN))[0].data.input).toMatchObject({
      message: 'my email is lena@example.com',
    });
  });
});

describe('BackofficeModule wiring (agent run traces)', () => {
  it('mounts the trace endpoints over the injected trace source', async () => {
    const source = createTraceSource(createMemoryAgentEventLog());
    const moduleRef = await Test.createTestingModule({
      imports: [
        BackofficeModule.register({
          helpdeskTrace: { provide: HELPDESK_TRACE_SOURCE, useValue: source },
        }),
      ],
    }).compile();
    expect(moduleRef.get(BackofficeHelpdeskAgentRunsController)).toBeInstanceOf(
      BackofficeHelpdeskAgentRunsController,
    );
    expect(moduleRef.get(HELPDESK_TRACE_SOURCE)).toBe(source);
    await moduleRef.close();
  });
});
