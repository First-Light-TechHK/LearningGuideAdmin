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
  BackofficeHelpdeskFaqGraphController,
  HELPDESK_FAQ_GRAPH_SERVICE,
  HELPDESK_FAQ_RELEASE_SERVICE,
} from '../nest/helpdesk-faq-graph.controller';

/**
 * FAQ 问题树员工端接口（graph design §5）的路由与权限：菜单 helpDesk VIEW 只读（边、树、问法、版本、
 * 差异），FULL 才能建 / 改 / 删边、重排、加删问法、新建 / 检查 / 发布 / 回滚版本；执行人是当前登录员工；
 * 幂等的写返回 200（已有）或 201（新建）；业务错误是统一信封 { code }。服务是假的（业务见
 * helpdesk-faq-graph.pg.spec.ts）。会话 mock。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const FID = '0192bbbb-0000-7000-8000-000000000001';
const EID = '0192bbbb-0000-7000-8000-0000000000e1';
const PID = '0192bbbb-0000-7000-8000-0000000000f1';

const graph = {
  edges: jest.fn(() => Promise.resolve({ children: [], parents: [] })),
  createEdge: jest.fn(() =>
    Promise.resolve({ edge: { id: EID }, created: true }),
  ),
  reorder: jest.fn(() => Promise.resolve({ children: [] })),
  edgeRevisions: jest.fn(() => Promise.resolve({ revisions: [] })),
  updateEdge: jest.fn(() => Promise.resolve({ id: EID })),
  deleteEdge: jest.fn(() => Promise.resolve({ deleted: true, edge: null })),
  tree: jest.fn(() =>
    Promise.resolve({ root: { node: { id: FID } }, nodes: 1 }),
  ),
  phrasings: jest.fn(() => Promise.resolve({ phrasings: [] })),
  addPhrasing: jest.fn(() =>
    Promise.resolve({ phrasing: { id: PID }, created: false }),
  ),
  deletePhrasing: jest.fn(() => Promise.resolve({ deleted: true })),
};
const releases = {
  list: jest.fn(() => Promise.resolve({ releases: [], published: null })),
  working: jest.fn(() =>
    Promise.resolve({ checks: {}, diff: {}, published: null }),
  ),
  diff: jest.fn(() =>
    Promise.resolve({ base: null, head: 'working', diff: {} }),
  ),
  create: jest.fn(() =>
    Promise.resolve({ release: { version: 1 }, created: true }),
  ),
  get: jest.fn(() => Promise.resolve({ version: 1 })),
  check: jest.fn(() => Promise.resolve({ version: 1 })),
  publish: jest.fn(() => Promise.resolve({ version: 1, status: 'published' })),
  rollback: jest.fn(() =>
    Promise.resolve({ release: { version: 3 }, created: false }),
  ),
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
  controllers: [BackofficeHelpdeskFaqGraphController],
  providers: [
    { provide: HELPDESK_FAQ_GRAPH_SERVICE, useValue: graph },
    { provide: HELPDESK_FAQ_RELEASE_SERVICE, useValue: releases },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class GraphTestModule {}

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
};

const READS = [
  `/api/helpdesk/faqs/${FID}/edges`,
  `/api/helpdesk/faqs/${FID}/edge-revisions`,
  `/api/helpdesk/faqs/${FID}/tree`,
  `/api/helpdesk/faqs/${FID}/phrasings`,
  '/api/helpdesk/faq-releases',
  '/api/helpdesk/faq-releases/working',
  '/api/helpdesk/faq-releases/diff?head=working',
  '/api/helpdesk/faq-releases/2',
  '/api/helpdesk/faq-releases/2/diff?base=1',
];

const WRITES: ['post' | 'put' | 'delete', string, object][] = [
  ['post', `/api/helpdesk/faqs/${FID}/edges`, { childId: EID }],
  ['put', `/api/helpdesk/faqs/${FID}/edges/order`, { childIds: [] }],
  ['put', `/api/helpdesk/faq-edges/${EID}`, { labelEn: null, labelZh: null }],
  ['delete', `/api/helpdesk/faq-edges/${EID}`, {}],
  [
    'post',
    `/api/helpdesk/faqs/${FID}/phrasings`,
    { locale: 'en-GB', text: 'x' },
  ],
  ['delete', `/api/helpdesk/faq-phrasings/${PID}`, {}],
  ['post', '/api/helpdesk/faq-releases', {}],
  ['post', '/api/helpdesk/faq-releases/2/check', {}],
  ['post', '/api/helpdesk/faq-releases/2/publish', {}],
  ['post', '/api/helpdesk/faq-releases/1/rollback', {}],
];

describe('FAQ question tree endpoints', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphTestModule],
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
  const send = (method: 'post' | 'put' | 'delete', path: string) =>
    method === 'post'
      ? request(server()).post(path)
      : method === 'put'
        ? request(server()).put(path)
        : request(server()).delete(path);

  it('requires a signed-in employee', async () => {
    for (const path of READS) await request(server()).get(path).expect(401);
  });

  it('has a role of each kind to test', () => {
    expect(viewRoles.length).toBeGreaterThan(0);
    expect(fullRoles.length).toBeGreaterThan(0);
  });

  it.each([...viewRoles, ...fullRoles])(
    '%s can read edges, trees, phrasings and releases',
    async (role) => {
      for (const path of READS)
        await request(server()).get(path).set('Cookie', as(role)).expect(200);
      expect(releases.diff).toHaveBeenCalledWith('working', undefined);
      expect(releases.diff).toHaveBeenCalledWith('2', '1');
    },
  );

  it.each(viewRoles)(
    '%s cannot change the tree or the releases',
    async (role) => {
      for (const [method, path, payload] of WRITES) {
        const res = await send(method, path)
          .set('Cookie', as(role))
          .send(payload)
          .expect(403);
        expect(body(res).error?.code).toBe('NOT_AUTHORISED');
      }
      const reads: unknown[] = [
        graph.edges,
        graph.edgeRevisions,
        graph.tree,
        graph.phrasings,
      ];
      for (const fn of [...Object.values(graph), ...Object.values(releases)])
        if (!reads.includes(fn)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(fullRoles)(
    '%s can change them, as the signed-in employee',
    async (role) => {
      const statuses: number[] = [];
      for (const [method, path, payload] of WRITES)
        statuses.push(
          (await send(method, path).set('Cookie', as(role)).send(payload))
            .status,
        );
      // 201 created, 200 already there (idempotent): edge 201, phrasing 200, release 201, rollback 200
      expect(statuses).toEqual([
        201, 200, 200, 200, 200, 200, 201, 200, 200, 200,
      ]);
      const actor = expect.objectContaining({
        employeeId: employeeFor(role).employeeId,
      }) as unknown;
      expect(graph.createEdge).toHaveBeenCalledWith(actor, FID, {
        childId: EID,
      });
      expect(releases.publish).toHaveBeenCalledWith(actor, '2');
      expect(releases.rollback).toHaveBeenCalledWith(actor, '1');
    },
  );

  it('turns a business error into the envelope with its status and code', async () => {
    graph.createEdge.mockImplementationOnce(() =>
      Promise.reject(new HelpdeskError(409, 'FAQ_EDGE_CYCLE', 'loop')),
    );
    const res = await request(server())
      .post(`/api/helpdesk/faqs/${FID}/edges`)
      .set('Cookie', as(fullRoles[0]))
      .send({ childId: EID })
      .expect(409);
    expect(body(res).error).toMatchObject({
      code: 'FAQ_EDGE_CYCLE',
      message: 'loop',
    });
  });
});
