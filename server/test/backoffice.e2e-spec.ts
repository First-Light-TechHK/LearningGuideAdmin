import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { query } from '../src/backoffice/lib/db';
import {
  E2E_PASSWORD,
  ensureEmployee,
  resetIpBuckets,
  resetRateLimits,
  signInAs,
} from './helpers/employee-session';

/**
 * BackOffice 员工登录与菜单级权限（PRD v1.1 §3.2 / §3.3 / §15.3）：
 * 每个角色只能用自己可见菜单背后的接口，Portal 学员端接口不受影响。
 */
describe('BackOffice access (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await query(`DELETE FROM employees WHERE login_email LIKE 'bo-e2e-%'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM employees WHERE login_email LIKE 'bo-e2e-%'`);
    await app.close();
  });

  const server = () => app.getHttpServer();

  beforeEach(() => resetRateLimits());

  it('rejects signed-out calls to BackOffice endpoints but keeps health public', async () => {
    await request(server()).get('/api/health').expect(200);
    const res = await request(server()).get('/api/courses').expect(401);
    expect(res.body.error.code).toBe('INVALID_EMPLOYEE_ACCOUNT');
    await request(server()).get('/api/session').expect(401);
    await request(server()).get('/api/admin/employees').expect(401);
  });

  it('does not let upper-case paths slip past the guard', async () => {
    await request(server()).get('/API/courses').expect(401);
    await request(server()).get('/Api/Admin/Employees').expect(401);
    await request(server()).post('/API/sync/all').expect(401);
  });

  it('ignores a spoofed X-Forwarded-For when rate limiting sign-in', async () => {
    for (let i = 0; i < 10; i += 1) {
      await request(server())
        .post('/api/auth/sign-in')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ email: `nobody${i}@example.com`, password: 'wrong-password' })
        .expect(401);
    }
    await request(server())
      .post('/api/auth/sign-in')
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ email: 'nobody99@example.com', password: 'wrong-password' })
      .expect(429);
  });

  it('limits sign-in attempts per account across addresses', async () => {
    for (let i = 0; i < 10; i += 1) {
      resetIpBuckets();
      await request(server())
        .post('/api/auth/sign-in')
        .send({ email: 'Target@Example.com', password: 'wrong-password' })
        .expect(401);
    }
    resetIpBuckets();
    await request(server())
      .post('/api/auth/sign-in')
      .send({ email: 'target@example.com', password: 'wrong-password' })
      .expect(429);
  });

  it('leaves the Portal learner API on the service key, not on employee sessions', async () => {
    await request(server()).get('/api/user/ai-tutors').expect(200);
  });

  // PRD §3.2：只有 NONE 隐藏菜单；Employee Account 仅 Admin
  const matrix: [
    string,
    { knowledge: number; aiTutor: number; employees: number },
  ][] = [
    ['ADMIN', { knowledge: 200, aiTutor: 200, employees: 200 }],
    ['COURSE_CREATOR', { knowledge: 200, aiTutor: 200, employees: 403 }],
    ['GRAPHIC_DESIGNER', { knowledge: 200, aiTutor: 200, employees: 403 }],
    ['FINANCE', { knowledge: 200, aiTutor: 200, employees: 403 }],
    ['OPERATION_ADMIN', { knowledge: 403, aiTutor: 403, employees: 403 }],
    ['OPERATION_AI', { knowledge: 200, aiTutor: 200, employees: 403 }],
  ];

  it.each(matrix)(
    '%s reaches exactly the menus the PRD matrix gives it',
    async (role, expected) => {
      const agent = await signInAs(app, role);
      await agent.get('/api/tags').expect(expected.knowledge);
      await agent.get('/api/courses').expect(expected.knowledge);
      await agent.get('/api/ai/models').expect(expected.aiTutor);
      await agent.get('/api/admin/employees').expect(expected.employees);

      const session = await agent.get('/api/session').expect(200);
      const menus: string[] = session.body.data.menus;
      expect(menus.includes('knowledge')).toBe(expected.knowledge === 200);
      expect(menus.includes('aiTutor')).toBe(expected.aiTutor === 200);
      expect(menus[0]).toBe('course');
      expect(session.body.data.canManageEmployeeAccount).toBe(role === 'ADMIN');
      expect(session.body.data.settings.includes('employeeAccount')).toBe(
        role === 'ADMIN',
      );
    },
  );

  it('runs the full employee lifecycle: create, activate, sign in, deactivate', async () => {
    const admin = await signInAs(app, 'ADMIN');
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = 'SIT'; // 没接邮件服务的非生产环境：链接交给 Admin
    let link: string;
    let employeeId: string;
    try {
      const created = await admin
        .post('/api/admin/employees')
        .set('Origin', 'http://localhost:5173')
        .send({
          email: 'BO-E2E-New@Example.com',
          role: 'OPERATION_AI',
          accountStatus: 'ACTIVE',
          locale: 'zh-CN',
        })
        .expect(200);
      expect(created.body.data.delivery).toBe('NOT_CONFIGURED');
      expect(created.body.data.employee.loginEmail).toBe(
        'bo-e2e-new@example.com',
      );
      expect(created.body.data.employee.displayStatus).toBe('Pending');
      link = created.body.data.manualLink;
      employeeId = created.body.data.employee.employeeId;
      expect(
        link.startsWith('http://localhost:5173/zh-CN/activate?token='),
      ).toBe(true);
    } finally {
      process.env.APP_ENV = previous;
    }

    const duplicate = await admin
      .post('/api/admin/employees')
      .send({ email: 'bo-e2e-new@example.com', role: 'FINANCE' })
      .expect(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_EMAIL');

    // Pending 账号不能登录
    const pending = await request(server())
      .post('/api/auth/sign-in')
      .send({ email: 'bo-e2e-new@example.com', password: 'whatever-password' })
      .expect(403);
    expect(pending.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = decodeURIComponent(
      new URL(link).searchParams.get('token') ?? '',
    );
    await request(server())
      .post('/api/auth/activate')
      .send({
        token,
        password: 'new-employee-pass',
        confirmPassword: 'new-employee-pass',
      })
      .expect(200);
    const reused = await request(server())
      .post('/api/auth/activate')
      .send({
        token,
        password: 'new-employee-pass',
        confirmPassword: 'new-employee-pass',
      })
      .expect(410);
    expect(reused.body.error.code).toBe('TOKEN_ALREADY_USED');

    const employee = request.agent(server());
    const signedIn = await employee
      .post('/api/auth/sign-in')
      .send({ email: 'bo-e2e-new@example.com', password: 'new-employee-pass' })
      .expect(200);
    expect(signedIn.body.data.locale).toBe('en-GB');
    await employee.get('/api/ai/models').expect(200);

    // BR-PORT-013：停用立即生效
    await admin
      .patch(`/api/admin/employees/${employeeId}`)
      .send({ accountStatus: 'INACTIVE' })
      .expect(200);
    await employee.get('/api/ai/models').expect(401);
    const inactive = await request(server())
      .post('/api/auth/sign-in')
      .send({ email: 'bo-e2e-new@example.com', password: 'new-employee-pass' })
      .expect(403);
    expect(inactive.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('keeps the language preference across sign-ins (PORT-NAV-006)', async () => {
    const email = await ensureEmployee('bo-e2e-locale@example.com', 'FINANCE');
    const first = request.agent(server());
    await first
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    await first
      .post('/api/preferences/locale')
      .send({ locale: 'zh-CN' })
      .expect(200);
    await first
      .post('/api/preferences/locale')
      .send({ locale: 'fr-FR' })
      .expect(400);
    await first.post('/api/auth/sign-out').expect(200);
    await first.get('/api/session').expect(401);

    const second = await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    expect(second.body.data.locale).toBe('zh-CN');
  });

  it('signs every session out after a password change (PORT-PWD-006)', async () => {
    const email = await ensureEmployee(
      'bo-e2e-password@example.com',
      'COURSE_CREATOR',
    );
    const agent = request.agent(server());
    await agent
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    const wrong = await agent
      .post('/api/auth/change-password')
      .send({
        currentPassword: 'not-the-password',
        newPassword: 'changed-password-1',
        confirmPassword: 'changed-password-1',
      })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    await agent
      .post('/api/auth/change-password')
      .send({
        currentPassword: E2E_PASSWORD,
        newPassword: 'changed-password-1',
        confirmPassword: 'changed-password-1',
      })
      .expect(200);
    await agent.get('/api/session').expect(401);
    await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: 'changed-password-1' })
      .expect(200);
  });

  it('refuses first-admin setup once any employee exists', async () => {
    await ensureEmployee('bo-e2e-existing@example.com', 'ADMIN');
    const state = await request(server()).get('/api/auth/setup').expect(200);
    expect(state.body.data.required).toBe(false);
    const res = await request(server())
      .post('/api/auth/setup')
      .send({
        email: 'bo-e2e-intruder@example.com',
        password: 'intruder-password',
        confirmPassword: 'intruder-password',
      })
      .expect(403);
    expect(res.body.error.code).toBe('NOT_AUTHORISED');
  });

  it('protects the bootstrap admin from being demoted or deactivated', async () => {
    const admin = await signInAs(app, 'ADMIN');
    await query(
      `INSERT INTO employees (login_email, role, account_status, email_verification, email_verified_at, password_hash, is_bootstrap_admin)
       VALUES ('bo-e2e-boot@example.com', 'ADMIN', 'ACTIVE', 'VERIFIED', now(), 'scrypt$x', true)
       ON CONFLICT (login_email) DO NOTHING`,
    );
    const rows = await query<{ employee_id: string }>(
      `SELECT employee_id FROM employees WHERE login_email = 'bo-e2e-boot@example.com'`,
    );
    const id = rows[0].employee_id;
    const res = await admin
      .patch(`/api/admin/employees/${id}`)
      .send({ role: 'FINANCE' })
      .expect(403);
    expect(res.body.error.code).toBe('PROTECTED_ADMIN_ACCOUNT');
    await admin
      .patch(`/api/admin/employees/${id}`)
      .send({ accountStatus: 'INACTIVE' })
      .expect(403);
    // 测试收尾需要删掉受保护管理员：临时关闭触发器
    await query(
      `ALTER TABLE employees DISABLE TRIGGER employees_guard_bootstrap_admin`,
    );
    await query(`DELETE FROM employees WHERE employee_id = $1`, [id]);
    await query(
      `ALTER TABLE employees ENABLE TRIGGER employees_guard_bootstrap_admin`,
    );
  });
});
