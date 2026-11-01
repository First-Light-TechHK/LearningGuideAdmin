import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { configureApp } from '../../common/app-setup';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { noCardRewriter } from '../../contracts/helpdesk-card-rewrite';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  type SessionEmployee,
} from '../contracts/employee';
import { createFaqRewriteService } from '../modules/helpdesk/faqs/faqRewrite';
import { levelFor } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import {
  BackofficeHelpdeskFaqReviewController,
  HELPDESK_FAQ_REVIEW_SERVICE,
  HELPDESK_FAQ_REWRITE_SERVICE,
} from '../nest/helpdesk-faq-review.controller';
import {
  BackofficeHelpdeskFaqsController,
  HELPDESK_FAQ_SERVICE,
} from '../nest/helpdesk-faqs.controller';

/**
 * FAQ 逐张审核与「AI 按指令改卡」的路由与权限：菜单 helpDesk VIEW 能看审核队列和改动历史，
 * FULL 才能审核和让 AI 改卡；修改人是当前登录员工；没有模型时 AI 改卡 503。
 * 和 FAQ 的老接口（GET /faqs/:id、POST /faqs/:id/archive）同在 /helpdesk/faqs 下，不互相抢路由。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const FID = '0192bbbb-0000-7000-8000-000000000001';
const KEY = '0192bbbb-0000-7000-8000-0000000000d1';

const reviews = {
  queue: jest.fn(() => Promise.resolve({ faqs: [], total: 0 })),
  review: jest.fn(() =>
    Promise.resolve({ review: { status: 'ok' }, replayed: false }),
  ),
  history: jest.fn(() => Promise.resolve({ faqId: FID, history: [] })),
};
const faqs = {
  get: jest.fn(() => Promise.resolve({ id: FID })),
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
  controllers: [
    BackofficeHelpdeskFaqsController,
    BackofficeHelpdeskFaqReviewController,
  ],
  providers: [
    { provide: HELPDESK_FAQ_SERVICE, useValue: faqs },
    { provide: HELPDESK_FAQ_REVIEW_SERVICE, useValue: reviews },
    {
      provide: HELPDESK_FAQ_REWRITE_SERVICE,
      useFactory: () => createFaqRewriteService({ rewriter: noCardRewriter }),
    },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class FaqReviewTestModule {}

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
};

const READS = [
  '/api/helpdesk/faq-reviews?status=unreviewed&page=2',
  `/api/helpdesk/faqs/${FID}/history`,
];
const REWRITE = {
  questionZh: '退款要多久？',
  answerZh: '5 个工作日。',
  questionEn: 'How long does a refund take?',
  answerEn: '5 working days.',
  category: 'payments_subscriptions',
  instruction: '更亲切一点',
  lang: 'zh',
};
const WRITES: [string, object][] = [
  [`/api/helpdesk/faqs/${FID}/review`, { status: 'ok', version: 1 }],
  ['/api/helpdesk/faqs/rewrite', REWRITE],
];

describe('FAQ review and AI rewrite endpoints', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FaqReviewTestModule],
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
    '%s can read the review queue and a card history',
    async (role) => {
      for (const path of READS)
        await request(server()).get(path).set('Cookie', as(role)).expect(200);
      expect(reviews.queue).toHaveBeenCalledWith({
        status: 'unreviewed',
        page: '2',
      });
      expect(reviews.history).toHaveBeenCalledWith(FID);
      // 老接口照旧：GET /faqs/:id 不被新路由抢走
      await request(server())
        .get(`/api/helpdesk/faqs/${FID}`)
        .set('Cookie', as(role))
        .expect(200);
      expect(faqs.get).toHaveBeenCalledWith(FID);
    },
  );

  it.each(viewRoles)('%s cannot review or ask the AI to edit', async (role) => {
    for (const [path, payload] of WRITES) {
      const res = await request(server())
        .post(path)
        .set('Cookie', as(role))
        .send(payload)
        .expect(403);
      expect(body(res).error?.code).toBe('NOT_AUTHORISED');
    }
    expect(reviews.review).not.toHaveBeenCalled();
  });

  it.each(fullRoles)(
    '%s reviews as the signed-in employee; AI editing answers 503 without a model',
    async (role) => {
      await request(server())
        .post(`/api/helpdesk/faqs/${FID}/review`)
        .set('Cookie', as(role))
        .set('Idempotency-Key', KEY)
        .send({ status: 'ok', version: 1 })
        .expect(200);
      expect(reviews.review).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: employeeFor(role).employeeId }),
        FID,
        { status: 'ok', version: 1 },
        KEY,
      );
      const res = await request(server())
        .post('/api/helpdesk/faqs/rewrite')
        .set('Cookie', as(role))
        .send(REWRITE)
        .expect(503);
      expect(body(res).error?.code).toBe('REWRITE_UNAVAILABLE');
      const bad = await request(server())
        .post('/api/helpdesk/faqs/rewrite')
        .set('Cookie', as(role))
        .send({ ...REWRITE, instruction: '' })
        .expect(400);
      expect(body(bad).error?.code).toBe('INVALID_INPUT');
    },
  );
});
