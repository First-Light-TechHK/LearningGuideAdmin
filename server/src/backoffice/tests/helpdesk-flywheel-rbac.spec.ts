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
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import { levelFor } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import {
  BackofficeHelpdeskFlywheelController,
  HELPDESK_FAQ_CANDIDATE_SERVICE,
  HELPDESK_FLYWHEEL_METRICS,
  HELPDESK_FLYWHEEL_RUNS_SERVICE,
} from '../nest/helpdesk-flywheel.controller';

/**
 * 数据飞轮员工端接口（v5 Part G3、G4、G6）的路由与权限：菜单 helpDesk VIEW 只读（候选、预填、运行、
 * 指标、回归用例、Portal 保留任务的记录），FULL 才能接受 / 驳回 / 合并、从工单转候选、立即运行；
 * 执行人是当前登录员工，Idempotency-Key 原样交给服务；业务错误是统一信封 { code }。
 * 服务是假的（业务见 helpdesk-flywheel.pg.spec.ts）。会话 mock。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const CID = '0192bbbb-0000-7000-8000-000000000001';
const TID = '0192bbbb-0000-7000-8000-0000000000a1';
const RID = '0192bbbb-0000-7000-8000-0000000000c1';
const KEY = '0192bbbb-0000-7000-8000-0000000000d1';

const candidates = {
  list: jest.fn(() => Promise.resolve({ candidates: [], total: 0 })),
  get: jest.fn(() => Promise.resolve({ candidate: { id: CID } })),
  draft: jest.fn(() => Promise.resolve({ candidateId: CID })),
  review: jest.fn(() => Promise.resolve({ candidateId: CID })),
  faqMap: jest.fn(() => Promise.resolve({ nodes: [] })),
  accept: jest.fn(() => Promise.resolve({ candidate: { id: CID } })),
  dismiss: jest.fn(() => Promise.resolve({ candidate: { id: CID } })),
  merge: jest.fn(() => Promise.resolve({ source: { id: CID } })),
  fromTicket: jest.fn(() =>
    Promise.resolve({ candidate: { id: CID }, created: true }),
  ),
  evalCasesJsonl: jest.fn(() =>
    Promise.resolve('{"faqKey":"a","locale":"zh-CN","text":"x"}'),
  ),
};
const runs = {
  list: jest.fn(() => Promise.resolve({ runs: [] })),
  get: jest.fn(() => Promise.resolve({ id: RID })),
  runNow: jest.fn(() => Promise.resolve({ run: { id: RID }, created: true })),
  portalRetentionRuns: jest.fn(() => Promise.resolve({ runs: [] })),
  runPortalRetention: jest.fn(() =>
    Promise.resolve({ outcome: 'completed', run: null }),
  ),
};
const metrics = {
  metrics: jest.fn(() => Promise.resolve({ series: [], totals: [] })),
};

function employeeFor(role: EmployeeRole): SessionEmployee {
  return {
    employeeId: `0192aaaa-0000-7000-8000-00000000000${EMPLOYEE_ROLES.indexOf(role)}`,
    loginEmail: `${role.toLowerCase()}@example.com`,
    role,
    displayName: role.toLowerCase(),
    accountStatus: 'ACTIVE',
    emailVerification: 'VERIFIED',
    displayStatus: 'Active',
    isBootstrapAdmin: false,
  };
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [BackofficeHelpdeskFlywheelController],
  providers: [
    { provide: HELPDESK_FAQ_CANDIDATE_SERVICE, useValue: candidates },
    { provide: HELPDESK_FLYWHEEL_RUNS_SERVICE, useValue: runs },
    { provide: HELPDESK_FLYWHEEL_METRICS, useValue: metrics },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class FlywheelTestModule {}

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
};

const READS = [
  '/api/helpdesk/faq-candidates?status=new&page=2',
  `/api/helpdesk/faq-candidates/${CID}`,
  `/api/helpdesk/faq-candidates/${CID}/draft`,
  `/api/helpdesk/faq-candidates/${CID}/review`,
  '/api/helpdesk/faq-map',
  '/api/helpdesk/faq-eval-cases',
  '/api/helpdesk/flywheel/jobs/gap_mining/runs',
  `/api/helpdesk/flywheel/jobs/gap_mining/runs/${RID}`,
  '/api/helpdesk/flywheel/metrics?granularity=week&split=entry',
  '/api/helpdesk/jobs/assist-retention',
];

const WRITES: [string, object][] = [
  [`/api/helpdesk/faq-candidates/${CID}/accept`, { as: 'new_faq', version: 1 }],
  [
    `/api/helpdesk/faq-candidates/${CID}/dismiss`,
    { reason: 'spam', version: 1 },
  ],
  [`/api/helpdesk/faq-candidates/${CID}/merge`, { targetId: RID, version: 1 }],
  [`/api/helpdesk/tickets/${TID}/faq-candidate`, {}],
  ['/api/helpdesk/flywheel/jobs/gap_mining/run', {}],
  ['/api/helpdesk/jobs/assist-retention/run', {}],
];

describe('data flywheel endpoints', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FlywheelTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
  const body = (res: request.Response) => res.body as Envelope;
  const viewRoles = EMPLOYEE_ROLES.filter(
    (r) => levelFor(r, 'helpDesk') === 'VIEW',
  );
  const fullRoles = EMPLOYEE_ROLES.filter(
    (r) => levelFor(r, 'helpDesk') === 'FULL',
  );

  it('requires a signed-in employee', async () => {
    for (const path of READS) await request(server()).get(path).expect(401);
    for (const [path] of WRITES) await request(server()).post(path).expect(401);
  });

  it.each([...viewRoles, ...fullRoles])(
    '%s can read candidates, drafts, runs and metrics',
    async (role) => {
      for (const path of READS)
        await request(server()).get(path).set('Cookie', as(role)).expect(200);
      expect(candidates.list).toHaveBeenCalledWith({
        status: 'new',
        page: '2',
      });
      expect(metrics.metrics).toHaveBeenCalledWith({
        granularity: 'week',
        split: 'entry',
      });
      expect(runs.get).toHaveBeenCalledWith('gap_mining', RID);
      const res = await request(server())
        .get('/api/helpdesk/faq-eval-cases')
        .set('Cookie', as(role));
      expect(body(res).data).toEqual({
        jsonl: '{"faqKey":"a","locale":"zh-CN","text":"x"}',
        count: 1,
      });
    },
  );

  it.each(viewRoles)(
    '%s cannot act on candidates or run jobs',
    async (role) => {
      for (const [path, payload] of WRITES) {
        const res = await request(server())
          .post(path)
          .set('Cookie', as(role))
          .send(payload)
          .expect(403);
        expect(body(res).error?.code).toBe('NOT_AUTHORISED');
      }
      for (const fn of [
        candidates.accept,
        candidates.dismiss,
        candidates.merge,
        candidates.fromTicket,
        runs.runNow,
        runs.runPortalRetention,
      ])
        expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(fullRoles)(
    '%s can act, as the signed-in employee, passing the Idempotency-Key through',
    async (role) => {
      const statuses: number[] = [];
      for (const [path, payload] of WRITES)
        statuses.push(
          (
            await request(server())
              .post(path)
              .set('Cookie', as(role))
              .set('Idempotency-Key', KEY)
              .send(payload)
          ).status,
        );
      expect(statuses).toEqual([200, 200, 200, 201, 201, 200]);
      const actor = expect.objectContaining({
        employeeId: employeeFor(role).employeeId,
      }) as unknown;
      expect(candidates.accept).toHaveBeenCalledWith(
        actor,
        CID,
        { as: 'new_faq', version: 1 },
        KEY,
      );
      expect(candidates.fromTicket).toHaveBeenCalledWith(actor, TID);
      expect(runs.runNow).toHaveBeenCalledWith(actor, 'gap_mining', KEY);
      expect(runs.runPortalRetention).toHaveBeenCalledWith(actor, KEY);
    },
  );

  it('answers 200 for a ticket already turned into a candidate and for a replayed run', async () => {
    candidates.fromTicket.mockImplementationOnce(() =>
      Promise.resolve({ candidate: { id: CID }, created: false }),
    );
    runs.runNow.mockImplementationOnce(() =>
      Promise.resolve({ run: { id: RID }, created: false }),
    );
    await request(server())
      .post(`/api/helpdesk/tickets/${TID}/faq-candidate`)
      .set('Cookie', as(fullRoles[0]))
      .expect(200);
    await request(server())
      .post('/api/helpdesk/flywheel/jobs/gap_mining/run')
      .set('Cookie', as(fullRoles[0]))
      .set('Idempotency-Key', KEY)
      .expect(200);
  });

  it('turns a business error into the envelope with its status and code', async () => {
    runs.runNow.mockImplementationOnce(() =>
      Promise.reject(new HelpdeskError(409, 'JOB_ALREADY_RUNNING', 'busy')),
    );
    const res = await request(server())
      .post('/api/helpdesk/flywheel/jobs/gap_mining/run')
      .set('Cookie', as(fullRoles[0]))
      .set('Idempotency-Key', KEY)
      .expect(409);
    expect(body(res).error).toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      message: 'busy',
    });
  });
});
