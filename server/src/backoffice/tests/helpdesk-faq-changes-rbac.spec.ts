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
  BackofficeHelpdeskFaqChangesController,
  HELPDESK_FAQ_CHANGE_LOG_SERVICE,
} from '../nest/helpdesk-faq-changes.controller';

/**
 * Change Log 接口（Figma 草案 2.6–2.9）的路由与权限：只读，菜单 helpDesk 的 VIEW 与 FULL 都能看，
 * 没登录 401，没有这个菜单的不存在（每个角色都至少 VIEW）；查询参数原样交给服务（校验在服务里，
 * 见 helpdesk-faq-change-log.pg.spec.ts），业务错误是统一信封 { code }。服务是假的。会话 mock。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

const FID = '0192bbbb-0000-7000-8000-000000000001';

const changes = {
  list: jest.fn(() =>
    Promise.resolve({
      changes: [],
      total: 0,
      page: 1,
      pageSize: 10,
      people: [],
    }),
  ),
  forFaq: jest.fn(() =>
    Promise.resolve({
      changes: [],
      total: 0,
      page: 1,
      pageSize: 10,
      truncated: false,
    }),
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
  controllers: [BackofficeHelpdeskFaqChangesController],
  providers: [
    { provide: HELPDESK_FAQ_CHANGE_LOG_SERVICE, useValue: changes },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: BackofficeAccessGuard },
  ],
})
class ChangesTestModule {}

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string } | null;
};

describe('FAQ change log endpoints', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ChangesTestModule],
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
  const readers = EMPLOYEE_ROLES.filter(
    (r) => levelFor(r, 'helpDesk') !== 'NONE',
  );

  it('requires a signed-in employee', async () => {
    await request(server()).get('/api/helpdesk/faq-changes').expect(401);
    await request(server())
      .get(`/api/helpdesk/faqs/${FID}/changes`)
      .expect(401);
    expect(changes.list).not.toHaveBeenCalled();
  });

  it('every role with the Help Desk menu (VIEW or FULL) can read who changed what', async () => {
    expect(readers).toEqual(
      expect.arrayContaining(['ADMIN', 'COURSE_CREATOR']),
    );
    for (const role of readers) {
      await request(server())
        .get(
          `/api/helpdesk/faq-changes?subject=faq&employee=system&faq=${FID}&from=2026-10-01&to=2026-10-30&q=refund&page=2&pageSize=20`,
        )
        .set('Cookie', as(role))
        .expect(200);
      await request(server())
        .get(`/api/helpdesk/faqs/${FID}/changes?page=1&pageSize=5`)
        .set('Cookie', as(role))
        .expect(200);
    }
    expect(changes.list).toHaveBeenLastCalledWith({
      subject: 'faq',
      employee: 'system',
      faq: FID,
      from: '2026-10-01',
      to: '2026-10-30',
      q: 'refund',
      page: '2',
      pageSize: '20',
    });
    expect(changes.forFaq).toHaveBeenLastCalledWith(FID, {
      page: '1',
      pageSize: '5',
    });
  });

  it('there is nothing to write: other methods are not routes', async () => {
    for (const method of ['post', 'put', 'delete'] as const)
      expect(
        [403, 404].includes(
          (
            await request(server())
              [method]('/api/helpdesk/faq-changes')
              .set('Cookie', as('ADMIN'))
          ).status,
        ),
      ).toBe(true);
  });

  it('turns a validation error into the envelope', async () => {
    changes.list.mockImplementationOnce(() =>
      Promise.reject(
        new HelpdeskError(400, 'INVALID_INPUT', 'Unknown subject'),
      ),
    );
    const res = await request(server())
      .get('/api/helpdesk/faq-changes?subject=x')
      .set('Cookie', as('ADMIN'))
      .expect(400);
    expect(body(res).error?.code).toBe('INVALID_INPUT');
  });
});
