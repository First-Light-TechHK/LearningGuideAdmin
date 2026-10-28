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
import type { HelpdeskQuestion } from '../modules/helpdesk/questions/questionContracts';
import { createQuestionService } from '../modules/helpdesk/questions/questionService';
import { levelFor } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';
import {
  BackofficeHelpdeskQuestionsController,
  HelpdeskIntegrationQuestionsController,
  HELPDESK_QUESTION_SERVICE,
} from '../nest/helpdesk-questions.controller';
import { createMemoryQuestionRepository } from './helpers/memoryQuestionRepository';

/**
 * Helpdesk addendum §A / §E / §F：
 * - 员工端 Common Questions：菜单 helpDesk VIEW 只读，FULL 才能写；
 * - Portal 读已发布问题：只认 Bearer ADMIN_HELPDESK_TOKEN（不要员工登录），
 *   缺失 / 错误 401、环境变量为空 503，错误体是 RFC 9457 problem+json；支持 ETag / If-None-Match。
 * 会话 mock；令牌是本地测试值。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const TOKEN = 'test-admin-helpdesk-token-local-only';
const QID = '0192bbbb-0000-7000-8000-000000000001';

const seed: HelpdeskQuestion = {
  id: QID,
  locale: 'en-GB',
  category: 'technical_support',
  question: 'How do I reset my password?',
  answer: 'Use Forgot password.',
  keywords: ['password'],
  status: 'published',
  featured: true,
  sortOrder: 10,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

let repository = createMemoryQuestionRepository([seed]);

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
    BackofficeHelpdeskQuestionsController,
    HelpdeskIntegrationQuestionsController,
  ],
  providers: [
    {
      provide: HELPDESK_QUESTION_SERVICE,
      useFactory: () =>
        createQuestionService({
          repository: {
            // 每个用例重建仓库，这里转发到当前实例
            list: (f) => repository.list(f),
            get: (id) => repository.get(id),
            nextSortOrder: (l) => repository.nextSortOrder(l),
            insert: (q, e) => repository.insert(q, e),
            update: (id, v, p, a, e) => repository.update(id, v, p, a, e),
            reorder: (i, e) => repository.reorder(i, e),
            revisions: (id) => repository.revisions(id),
            listPublished: (l, f) => repository.listPublished(l, f),
            searchCandidates: (i) => repository.searchCandidates(i),
          },
        }),
    },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class QuestionsTestModule {}

type Envelope = {
  success: boolean;
  data: Record<string, unknown> & { questions?: { id: string }[] };
  error: { code: string } | null;
};

describe('Common Questions endpoints', () => {
  let app: INestApplication<App>;
  const savedToken = process.env.ADMIN_HELPDESK_TOKEN;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [QuestionsTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.ADMIN_HELPDESK_TOKEN;
    else process.env.ADMIN_HELPDESK_TOKEN = savedToken;
  });

  beforeEach(() => {
    repository = createMemoryQuestionRepository([seed]);
    process.env.ADMIN_HELPDESK_TOKEN = TOKEN;
    (resolveSession as jest.Mock).mockReset();
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
  const create = {
    locale: 'en-GB',
    category: 'other',
    question: 'Can I pause my plan?',
    answer: 'Yes, from Subscription.',
    keywords: ['pause'],
    featured: false,
    publish: true,
  };

  describe('employee side (session + helpDesk menu)', () => {
    it('requires a signed-in employee', async () => {
      const res = await request(server())
        .get('/api/helpdesk/questions')
        .expect(401);
      expect(body(res).error?.code).toBe('INVALID_EMPLOYEE_ACCOUNT');
    });

    it.each(viewRoles)('%s can list, open and see revisions', async (role) => {
      const list = await request(server())
        .get('/api/helpdesk/questions?locale=en-GB')
        .set('Cookie', as(role))
        .expect(200);
      expect(body(list).data.questions?.map((q) => q.id)).toEqual([QID]);
      await request(server())
        .get(`/api/helpdesk/questions/${QID}`)
        .set('Cookie', as(role))
        .expect(200);
      await request(server())
        .get(`/api/helpdesk/questions/${QID}/revisions`)
        .set('Cookie', as(role))
        .expect(200);
    });

    it.each(viewRoles)(
      '%s cannot create, edit, publish, unpublish, archive or reorder',
      async (role) => {
        const writes: [string, string, unknown][] = [
          ['post', '/api/helpdesk/questions', create],
          ['put', `/api/helpdesk/questions/${QID}`, { ...create, version: 1 }],
          ['post', `/api/helpdesk/questions/${QID}/publish`, { version: 1 }],
          ['post', `/api/helpdesk/questions/${QID}/unpublish`, { version: 1 }],
          ['post', `/api/helpdesk/questions/${QID}/archive`, { version: 1 }],
          [
            'post',
            '/api/helpdesk/questions/reorder',
            { items: [{ id: QID, version: 1 }] },
          ],
        ];
        for (const [method, path, payload] of writes) {
          const req =
            method === 'post'
              ? request(server()).post(path)
              : request(server()).put(path);
          const res = await req
            .set('Cookie', as(role))
            .send(payload as object)
            .expect(403);
          expect(body(res).error?.code).toBe('NOT_AUTHORISED');
        }
        expect(repository.rows.get(QID)?.version).toBe(1);
        expect(repository.rows.size).toBe(1);
      },
    );

    it.each(fullRoles)(
      '%s can create (201) and the creator is the signed-in employee',
      async (role) => {
        const res = await request(server())
          .post('/api/helpdesk/questions')
          .set('Cookie', as(role))
          .send({ ...create, createdBy: 'forged' })
          .expect(201);
        expect(body(res).data).toMatchObject({
          status: 'published',
          version: 1,
          createdBy: employeeFor(role).employeeId,
        });
      },
    );

    it.each(fullRoles)(
      '%s can edit, unpublish, archive and reorder',
      async (role) => {
        const cookie = as(role);
        await request(server())
          .put(`/api/helpdesk/questions/${QID}`)
          .set('Cookie', cookie)
          .send({ ...create, version: 1 })
          .expect(200);
        await request(server())
          .post(`/api/helpdesk/questions/${QID}/unpublish`)
          .set('Cookie', cookie)
          .send({ version: 2 })
          .expect(200);
        await request(server())
          .post('/api/helpdesk/questions/reorder')
          .set('Cookie', cookie)
          .send({ items: [{ id: QID, version: 3 }] })
          .expect(200);
        const archived = await request(server())
          .post(`/api/helpdesk/questions/${QID}/archive`)
          .set('Cookie', cookie)
          .send({ version: 3 })
          .expect(200);
        expect(body(archived).data).toMatchObject({
          status: 'archived',
          version: 4,
        });
      },
    );

    it('answers a stale version with 409 VERSION_CONFLICT in the envelope', async () => {
      const res = await request(server())
        .post(`/api/helpdesk/questions/${QID}/unpublish`)
        .set('Cookie', as('ADMIN'))
        .send({ version: 9 })
        .expect(409);
      expect(body(res).error?.code).toBe('VERSION_CONFLICT');
    });

    it('answers bad input with 400 INVALID_INPUT', async () => {
      const res = await request(server())
        .post('/api/helpdesk/questions')
        .set('Cookie', as('ADMIN'))
        .send({ ...create, locale: 'fr' })
        .expect(400);
      expect(body(res).error?.code).toBe('INVALID_INPUT');
    });

    it('answers a repeated list query parameter with 400 INVALID_INPUT, not 500', async () => {
      for (const query of ['q=a&q=b', 'locale=en-GB&locale=zh-CN']) {
        const res = await request(server())
          .get(`/api/helpdesk/questions?${query}`)
          .set('Cookie', as('ADMIN'))
          .expect(400);
        expect(body(res).error?.code).toBe('INVALID_INPUT');
      }
    });
  });

  describe('Portal side: GET /api/integration/helpdesk/questions', () => {
    const path =
      '/api/integration/helpdesk/questions?locale=en-GB&featured=true';

    function expectProblem(
      res: request.Response,
      status: number,
      code: string,
    ) {
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'code',
        'detail',
        'status',
        'title',
        'type',
      ]);
      expect(body).toMatchObject({
        type: `https://www.ilovelearningguide.com/problems/${code}`,
        status,
        code,
      });
      expect(typeof body.title).toBe('string');
      expect(typeof body.detail).toBe('string');
    }

    it('returns published questions with an ETag and no employee session', async () => {
      const res = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(200);
      expect(resolveSession).not.toHaveBeenCalled();
      expect(res.headers.etag).toMatch(/^"/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toEqual({
        questions: [
          {
            id: QID,
            category: 'technical_support',
            question: seed.question,
            answer: seed.answer,
          },
        ],
        etag: res.headers.etag,
      });
    });

    it('answers 304 with no body for a matching If-None-Match', async () => {
      const first = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(200);
      const res = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
      expect(res.text).toBe('');
      expect(res.headers.etag).toBe(first.headers.etag);
    });

    it('rejects a missing token with 401 problem+json', async () => {
      const res = await request(server()).get(path).expect(401);
      expectProblem(res, 401, 'invalid_token');
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="helpdesk", error="invalid_token"',
      );
    });

    it('rejects a wrong token with 401, and an employee cookie does not help', async () => {
      const res = await request(server())
        .get(path)
        .set('Cookie', as('ADMIN'))
        .set('Authorization', 'Bearer wrong-token')
        .expect(401);
      expectProblem(res, 401, 'invalid_token');
      const cookieOnly = await request(server())
        .get(path)
        .set('Cookie', as('ADMIN'))
        .expect(401);
      expectProblem(cookieOnly, 401, 'invalid_token');
    });

    it('answers 503 integration_disabled when ADMIN_HELPDESK_TOKEN is empty', async () => {
      process.env.ADMIN_HELPDESK_TOKEN = '  ';
      const res = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(503);
      expectProblem(res, 503, 'integration_disabled');
    });

    it('answers bad query parameters with 400 problem+json', async () => {
      const res = await request(server())
        .get('/api/integration/helpdesk/questions?locale=fr')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(400);
      expectProblem(res, 400, 'invalid_request');
      const repeated = await request(server())
        .get(
          '/api/integration/helpdesk/questions?locale=en-GB&locale=zh-CN&featured=true&featured=false',
        )
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(400);
      expectProblem(repeated, 400, 'invalid_request');
    });
  });
});
