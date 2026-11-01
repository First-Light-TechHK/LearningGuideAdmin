import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
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
    source: 'submit',
    category: 'technical_support',
    subject: 'Cannot log in',
    message: 'Help',
  };

  it('returns { suggestion } as plain JSON with no envelope', async () => {
    const suggestion = { id: SID, faqId: 'q1', question: 'Q', answer: 'A' };
    service.suggest.mockResolvedValue({ suggestion });
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ suggestion });
    expect(service.suggest).toHaveBeenCalledWith(body, {
      traceparent: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('passes the W3C traceparent header through to the service', async () => {
    service.suggest.mockResolvedValue({ suggestion: null });
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('traceparent', traceparent)
      .send(body)
      .expect(200);
    const [, context] = service.suggest.mock.calls[0] as [
      unknown,
      { traceparent?: string; signal: AbortSignal },
    ];
    expect(context.traceparent).toBe(traceparent);
    // a finished response does not count as an abort
    expect(context.signal.aborted).toBe(false);
  });

  it('aborts the run when Portal gives up and closes the connection', async () => {
    let seen: AbortSignal | undefined;
    const aborted = new Promise<boolean>((resolve) => {
      service.suggest.mockImplementation(
        (_raw: unknown, context: { signal: AbortSignal }) => {
          seen = context.signal;
          return new Promise((done) => {
            context.signal.addEventListener('abort', () => {
              resolve(true);
              done({ suggestion: null });
            });
          });
        },
      );
    });
    await app.listen(0);
    const address = (
      app.getHttpServer() as unknown as http.Server
    ).address() as {
      port: number;
    };
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/api/integration/helpdesk/suggest',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    req.on('error', () => undefined);
    req.end(payload);
    for (let i = 0; !seen && i < 400; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    expect(seen?.aborted).toBe(false);
    req.destroy();
    await expect(aborted).resolves.toBe(true);
  });

  describe('as a stream when Portal asks for text/event-stream (the thinking panel)', () => {
    const events = (text: string) =>
      text
        .split('\n\n')
        .filter((chunk) => chunk.trim() !== '')
        .map((chunk) => {
          const lines = chunk.split('\n');
          const event = lines.find((l) => l.startsWith('event: '));
          const data = lines.find((l) => l.startsWith('data: '));
          return [
            event?.slice('event: '.length),
            JSON.parse(data?.slice('data: '.length) ?? 'null') as unknown,
          ];
        });
    const stream = () =>
      request(server())
        .post('/api/integration/helpdesk/suggest')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Accept', 'text/event-stream')
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        })
        .send(body);

    it('sends each step name as it starts, then the same JSON as one event', async () => {
      const suggestion = { id: SID, faqId: 'q1', question: 'Q', answer: 'A' };
      service.suggest.mockImplementation(
        (_body: unknown, context: { onStep?: (step: string) => void }) => {
          context.onStep?.('retrieve');
          context.onStep?.('pick');
          return Promise.resolve({ suggestion });
        },
      );
      const res = await stream().expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(events(res.body as string)).toEqual([
        ['step', { step: 'retrieve' }],
        ['step', { step: 'pick' }],
        ['result', { suggestion }],
      ]);
    });

    it('sends an error the way it is sent today, as the last event', async () => {
      service.suggest.mockRejectedValue(
        problem(400, 'invalid_request', 'message is required'),
      );
      const res = await stream().expect(200);
      expect(events(res.body as string)).toEqual([
        [
          'error',
          {
            type: 'https://www.ilovelearningguide.com/problems/invalid_request',
            title: 'Bad Request',
            status: 400,
            detail: 'message is required',
            code: 'invalid_request',
          },
        ],
      ]);
    });

    it('hides unexpected errors in the error event too', async () => {
      service.suggest.mockImplementation(
        (_body: unknown, context: { onStep?: (step: string) => void }) => {
          context.onStep?.('retrieve');
          return Promise.reject(new Error('SELECT secret FROM x'));
        },
      );
      const res = await stream().expect(200);
      const sent = events(res.body as string);
      expect(sent[0]).toEqual(['step', { step: 'retrieve' }]);
      expect(sent[1]).toEqual([
        'error',
        expect.objectContaining({ status: 500, code: 'internal_error' }),
      ]);
      expect(res.body).not.toContain('secret');
    });
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

  it('returns the alternatives as is (v3 §1)', async () => {
    const answer = {
      suggestion: null,
      alternatives: [
        {
          faqId: '0192bbbb-0000-7000-8000-000000000001',
          question: 'How do I reset my password?',
        },
      ],
    };
    service.suggest.mockResolvedValue(answer);
    const res = await request(server())
      .post('/api/integration/helpdesk/suggest')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body)
      .expect(200);
    expect(res.body).toEqual(answer);
    expect(res.headers['cache-control']).toBe('no-store');
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
            useValue: {
              findCandidates: () => Promise.resolve([]),
              findPublished: () => Promise.resolve(null),
              findPopular: () => Promise.resolve([]),
            },
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

  it('writes pending traces when the app shuts down (SIGTERM via enableShutdownHooks)', async () => {
    const moduleRef = await compile(true);
    const flush = jest.spyOn(
      moduleRef.get(HelpdeskSuggestService),
      'flushTraces',
    );
    await moduleRef.close();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8'),
    ).toMatch(/app\.enableShutdownHooks\(\)/);
  });

  it('does not mount them without the agent role', async () => {
    const moduleRef = await compile(false);
    expect(() => moduleRef.get(HelpdeskSuggestController)).toThrow();
    await moduleRef.close();
  });
});
