import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import type { SessionPayload } from '../src/backoffice/nest/auth.controller';
import { closePool, query } from '../src/backoffice/lib/db';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import type { SuccessResponse } from './helpers/http-response';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from './helpers/migration-db';

/**
 * QA 3.1.1 端到端：全新库（全部迁移，员工表里只有 20261023170000 建的占位管理员）
 * 用 BOOTSTRAP_ADMIN_* 启动真实服务 → onModuleInit 的 bootstrap 轮换占位行，
 * env 管理员能通过 HTTP 登录，审计事件可查。
 *
 * 运行时每个用例自建临时库（仓库既有 migration-db 设施），不碰共享 e2e 库。
 */
const PLACEHOLDER_EMAIL = 'admin@ilovelearningguide.com';
const ENV_EMAIL = 'sandbox-bootstrap-e2e@example.test';
const ENV_PASSWORD = 'sandbox-bootstrap-e2e-password-1';
const BASE_DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const describeDatabase = BASE_DATABASE_URL === '' ? describe.skip : describe;

jest.setTimeout(240_000);

type EmployeeRow = {
  employee_id: string;
  login_email: string;
  role: string;
  account_status: string;
  email_verification: string;
  is_bootstrap_admin: boolean;
};

describeDatabase('bootstrap admin from env at service startup (e2e)', () => {
  const saved = {
    databaseUrl: process.env.DATABASE_URL,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  };
  let database: ScratchDatabase | null = null;
  let app: INestApplication<App> | null = null;

  beforeAll(async () => {
    await closePool();
    process.env.DATABASE_URL = BASE_DATABASE_URL;
    database = await createScratchDatabase();
    await database.applyMigrations();
    const url = new URL(BASE_DATABASE_URL);
    url.pathname = `/${database.name}`;
    url.search = '';
    process.env.DATABASE_URL = url.toString();
    process.env.BOOTSTRAP_ADMIN_EMAIL = ENV_EMAIL;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = ENV_PASSWORD;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closePool();
    if (database) await database.drop();
    if (saved.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.databaseUrl;
    if (saved.email === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    else process.env.BOOTSTRAP_ADMIN_EMAIL = saved.email;
    if (saved.password === undefined)
      delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = saved.password;
  });

  it('rotates the placeholder at startup so the env admin can sign in over HTTP', async () => {
    const server = app!.getHttpServer();

    // 启动后（onModuleInit 已跑完）占位行被一次性轮换，且仍是唯一的受保护管理员。
    const afterStartup = await query<EmployeeRow>(
      `SELECT employee_id, login_email, role, account_status, email_verification,
              is_bootstrap_admin
         FROM employees`,
    );
    expect(afterStartup).toEqual([
      {
        employee_id: expect.any(String) as string,
        login_email: ENV_EMAIL,
        role: 'ADMIN',
        account_status: 'ACTIVE',
        email_verification: 'VERIFIED',
        is_bootstrap_admin: true,
      },
    ]);
    const employeeId = afterStartup[0].employee_id;

    const agent = request.agent(server);
    await agent
      .post('/api/auth/sign-in')
      .send({ email: ENV_EMAIL, password: ENV_PASSWORD })
      .expect(200);

    const session: SuccessResponse<SessionPayload> = await agent
      .get('/api/session')
      .expect(200);
    expect(session.body.data.employee).toMatchObject({
      loginEmail: ENV_EMAIL,
      role: 'ADMIN',
      isBootstrapAdmin: true,
    });

    // 旧占位邮箱已不存在，不能再用 env 密码登录。
    await request(server)
      .post('/api/auth/sign-in')
      .send({ email: PLACEHOLDER_EMAIL, password: ENV_PASSWORD })
      .expect(401);

    const audits = await query<{
      action: string;
      old_value: string | null;
      new_value: string | null;
      target_employee_id: string | null;
    }>(
      `SELECT action, old_value, new_value, target_employee_id
         FROM audit_events
        WHERE event_name = 'bootstrap_admin_rotated'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'UPDATE_EMPLOYEE',
      old_value: PLACEHOLDER_EMAIL,
      new_value: ENV_EMAIL,
      target_employee_id: employeeId,
    });
  });
});
