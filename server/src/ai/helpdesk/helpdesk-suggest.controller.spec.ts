import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { BackofficeAccessGuard } from '../../backoffice/nest/backoffice-access.guard';
import { resolveSession } from '../../backoffice/modules/user-authentication/services/session';
import { configureApp } from '../../common/app-setup';
import { problem } from '../../common/problem';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { HELPDESK_QA_SOURCE } from '../../contracts/helpdesk-qa';
import { KNOWLEDGE_CLIENT } from '../../ks/contract/knowledge-client';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiModule } from '../ai.module';
import { HelpdeskSuggestController } from './helpdesk-suggest.controller';
import { HelpdeskSuggestService } from './helpdesk-suggest.service';

/**
 * Helpdesk addendum §C / §E：POST /api/integration/helpdesk/suggest 与
 * /suggestions/:id/outcome 只认 Bearer ADMIN_HELPDESK_TOKEN（无员工登录），
 * 成功体是纯 JSON，错误是 problem+json。服务层用假的；令牌是本地测试值。
 */
jest.mock(
  '../../backoffice/modules/user-authentication/services/session',
  () => ({
    resolveSession: jest.fn().mockResolvedValue(null),
  }),
);

const TOKEN = 'test-admin-helpdesk-token-local-only';
const SID = '0192eeee-0000-7000-8000-000000000001';

const service = {
  suggest: jest.fn(),
  recordOutcome: jest.fn(),
};

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [HelpdeskSuggestController],
  providers: [
    { provide: HelpdeskSuggestService, useValue: service },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class SuggestTestModule {}

describe('Helpdesk suggest integration endpoints', () => {
  let app: INestApplication<App>;
  const saved = process.env.ADMIN_HELPDESK_TOKEN;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SuggestTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.ADMIN_HELPDESK_TOKEN;
    else process.env.ADMIN_HELPDESK_TOKEN = saved;
  });

  beforeEach(() => {
    process.env.ADMIN_HELPDESK_TOKEN = TOKEN;
    service.suggest.mockReset();
    service.recordOutcome.mockReset();
  });

  const server = () => app.getHttpServer();
  const body = {
    learnerId: 'portal-user-1',
    locale: 'en-GB',
    category: 'technical_support',
    subject: 'Cannot log in',
    message: 'Help',
  };

  it('returns { suggestion } as plain JSON with no envelope', async () => {
    const suggestion = { id: SID, qaId: 'q1', question: 'Q', answer: 'A' };
    service.suggest.mockResolvedValue({ suggestion });
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ suggestion });
    expect(service.suggest).toHaveBeenCalledWith(body);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('returns { suggestion: null } as is', async () => {
    service.suggest.mockResolvedValue({ suggestion: null });
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ suggestion: null });
  });

  it('records an outcome', async () => {
    service.recordOutcome.mockResolvedValue({
      id: SID,
      outcome: 'solved',
      changed: true,
    });
    const res = await request(server())
      .post(`/api/integration/helpdesk/suggestions/${SID}/outcome`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ outcome: 'solved' })
      .expect(200);
    expect(res.body).toEqual({ id: SID, outcome: 'solved', changed: true });
    expect(service.recordOutcome).toHaveBeenCalledWith(SID, {
      outcome: 'solved',
    });
  });

  it.each([
    ['no token', undefined, 401, 'invalid_token'],
    ['a wrong token', 'Bearer nope', 401, 'invalid_token'],
  ])('rejects %s with problem+json', async (_name, header, status, code) => {
    for (const path of [
      '/api/integration/helpdesk/suggest',
      `/api/integration/helpdesk/suggestions/${SID}/outcome`,
    ]) {
      const req = request(server()).post(path);
      if (header) req.set('Authorization', header);
      const res = await req.send(body).expect(status);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status, code });
      // Same challenge as Portal's integration API (RFC 6750 §3).
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="helpdesk", error="invalid_token"',
      );
    }
    expect(service.suggest).not.toHaveBeenCalled();
    expect(service.recordOutcome).not.toHaveBeenCalled();
  });

  it('answers 503 integration_disabled when the token env is empty', async () => {
    delete process.env.ADMIN_HELPDESK_TOKEN;
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(503);
    expect(res.body).toMatchObject({
      type: 'https://www.ilovelearningguide.com/problems/integration_disabled',
      status: 503,
      code: 'integration_disabled',
    });
  });

  it('renders service errors as problem+json', async () => {
    service.recordOutcome.mockRejectedValue(
      problem(404, 'not_found', 'No such suggestion'),
    );
    const res = await request(server())
      .post(`/api/integration/helpdesk/suggestions/${SID}/outcome`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ outcome: 'solved' })
      .expect(404);
    expect(res.body).toEqual({
      type: 'https://www.ilovelearningguide.com/problems/not_found',
      title: 'Not Found',
      status: 404,
      detail: 'No such suggestion',
      code: 'not_found',
    });
  });

  it('hides unexpected errors behind a 500 problem', async () => {
    service.suggest.mockRejectedValue(new Error('SELECT secret FROM x'));
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(500);
    expect(res.body).toMatchObject({ status: 500, code: 'internal_error' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('turns malformed JSON into a 400 problem', async () => {
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send('{"learnerId":')
      .expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'invalid_request' });
  });
});

describe('AiModule.register wiring (agent role owns suggest)', () => {
  // 只编译不启动：不连数据库、不调模型
  async function compile(learnerApi: boolean) {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AiModule.register({
          adminApi: false,
          learnerApi,
          knowledge: { provide: KNOWLEDGE_CLIENT, useValue: {} },
          helpdeskQa: {
            provide: HELPDESK_QA_SOURCE,
            useValue: { findCandidates: () => Promise.resolve([]) },
          },
        }),
      ],
    }).compile();
  }

  it('mounts the suggest endpoints with the agent role', async () => {
    const moduleRef = await compile(true);
    expect(moduleRef.get(HelpdeskSuggestController)).toBeInstanceOf(
      HelpdeskSuggestController,
    );
    expect(moduleRef.get(HelpdeskSuggestService)).toBeInstanceOf(
      HelpdeskSuggestService,
    );
    await moduleRef.close();
  });

  it('does not mount them without the agent role', async () => {
    const moduleRef = await compile(false);
    expect(() => moduleRef.get(HelpdeskSuggestController)).toThrow();
    await moduleRef.close();
  });
});
