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
import {
  issueActivationToken,
  issueResetToken,
} from '../src/backoffice/modules/user-authentication/services/verificationTokens';

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

  it('does not let failures from another address lock an employee out', async () => {
    const email = await ensureEmployee('bo-e2e-victim@example.com', 'FINANCE');
    // 攻击者在别的 IP 上把这个邮箱的失败次数打满
    globalThis.__lgboRateBuckets?.set(`sign-in-pair:203.0.113.9:${email}`, {
      count: 99,
      resetsAt: Date.now() + 60_000,
    });
    await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
  });

  it('counts only failed sign-ins, and a success clears the account window', async () => {
    const email = await ensureEmployee('bo-e2e-often@example.com', 'FINANCE');
    for (let i = 0; i < 12; i += 1) {
      await request(server())
        .post('/api/auth/sign-in')
        .send({ email, password: E2E_PASSWORD })
        .expect(200);
    }
    for (let i = 0; i < 9; i += 1) {
      await request(server())
        .post('/api/auth/sign-in')
        .send({ email, password: 'wrong-password' })
        .expect(401);
    }
    await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    resetIpBuckets();
    for (let i = 0; i < 9; i += 1) {
      await request(server())
        .post('/api/auth/sign-in')
        .send({ email, password: 'wrong-password' })
        .expect(401);
    }
    await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
  });

  it('answers a wrong password and an unknown email the same way, and hides status until the password is right', async () => {
    const unknown = await request(server())
      .post('/api/auth/sign-in')
      .send({ email: 'bo-e2e-nobody@example.com', password: 'whatever-pass' })
      .expect(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');

    const email = await ensureEmployee('bo-e2e-off@example.com', 'FINANCE');
    await query(
      `UPDATE employees SET account_status = 'INACTIVE' WHERE login_email = $1`,
      [email],
    );
    const wrong = await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const right = await request(server())
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(403);
    expect(right.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
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

  // PRD §1.4：View 只读，写操作要 Edit/Full。守卫先于输入校验执行：
  // 放行的角色拿到 400/404（请求体或数据不对），被拦的角色拿到 403
  const writeMatrix: [string, boolean][] = [
    ['ADMIN', true],
    ['COURSE_CREATOR', false],
    ['GRAPHIC_DESIGNER', false],
    ['FINANCE', false],
    ['OPERATION_ADMIN', false],
    ['OPERATION_AI', true],
  ];

  it.each(writeMatrix)(
    '%s may change Knowledge and AI Tutor data only with Full access (allowed=%s)',
    async (role, allowed) => {
      const agent = await signInAs(app, role);
      const denied = (res: request.Response) => res.status === 403;
      expect(denied(await agent.post('/api/tags').send({}))).toBe(!allowed);
      expect(
        denied(
          await agent.delete(
            '/api/courses/00000000-0000-0000-0000-000000000000',
          ),
        ),
      ).toBe(!allowed);
      expect(denied(await agent.put('/api/ai/config').send({}))).toBe(!allowed);
      expect(
        denied(
          await agent.put('/api/ai/config/no-such-course/online').send({}),
        ),
      ).toBe(!allowed);
      const forbidden = await agent.post('/api/sync/all').send({});
      if (!allowed) {
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('NOT_AUTHORISED');
      }
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

    // Pending 账号还没有密码，不能登录（与密码错误同码）
    const pending = await request(server())
      .post('/api/auth/sign-in')
      .send({ email: 'bo-e2e-new@example.com', password: 'whatever-password' })
      .expect(401);
    expect(pending.body.error.code).toBe('INVALID_CREDENTIALS');

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

  it('keeps the one-time link after the email was delivered', async () => {
    const admin = await signInAs(app, 'ADMIN');
    const previous = process.env.EMAIL_DELIVERY;
    process.env.EMAIL_DELIVERY = 'discard';
    try {
      const created = await admin
        .post('/api/admin/employees')
        .send({
          email: 'bo-e2e-sent@example.com',
          role: 'FINANCE',
          locale: 'en-GB',
        })
        .expect(200);
      expect(created.body.data.delivery).toBe('SENT');
      expect(created.body.data.manualLink).toContain('/en-GB/activate?token=');

      const reset = await admin
        .post(
          `/api/admin/employees/${created.body.data.employee.employeeId}/reset-password`,
        )
        .send({ locale: 'en-GB' })
        .expect(200);
      // 还没激活的账号：重置改为重发激活邮件
      expect(reset.body.data.delivery).toBe('SENT');
      expect(reset.body.data.manualLink).toContain('/en-GB/activate?token=');
    } finally {
      process.env.EMAIL_DELIVERY = previous;
      await query(
        `DELETE FROM employees WHERE login_email = 'bo-e2e-sent@example.com'`,
      );
    }
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

  describe('one-time links', () => {
    const tokenOf = (link: string) =>
      decodeURIComponent(new URL(link).searchParams.get('token') ?? '');

    async function createPending(email: string) {
      const admin = await signInAs(app, 'ADMIN');
      const previous = process.env.APP_ENV;
      process.env.APP_ENV = 'SIT';
      try {
        const created = await admin
          .post('/api/admin/employees')
          .send({ email, role: 'FINANCE', locale: 'en-GB' })
          .expect(200);
        return {
          admin,
          employeeId: created.body.data.employee.employeeId as string,
          activation: tokenOf(created.body.data.manualLink),
        };
      } finally {
        process.env.APP_ENV = previous;
      }
    }

    const status = async (token: string, purpose: string) =>
      (
        await request(server())
          .get('/api/auth/token-status')
          .query({ token, purpose })
          .expect(200)
      ).body.data.status;

    it('voids the activation link once a reset link has set the password', async () => {
      const { employeeId, activation } = await createPending(
        'bo-e2e-link1@example.com',
      );
      // 旧版本里 Admin 对 Pending 账号点重置会签发重置令牌：直接签一个模拟
      const reset = await issueResetToken(employeeId);
      await request(server())
        .post('/api/auth/reset-password')
        .send({
          token: reset,
          password: 'reset-pass-123',
          confirmPassword: 'reset-pass-123',
        })
        .expect(200);
      expect(await status(activation, 'activation')).toBe('used');
      const replay = await request(server())
        .post('/api/auth/activate')
        .send({
          token: activation,
          password: 'attacker-pass',
          confirmPassword: 'attacker-pass',
        })
        .expect(410);
      expect(replay.body.error.code).toBe('TOKEN_ALREADY_USED');
      await request(server())
        .post('/api/auth/sign-in')
        .send({ email: 'bo-e2e-link1@example.com', password: 'attacker-pass' })
        .expect(401);
    });

    it('refuses an activation link for an account that is already verified', async () => {
      await ensureEmployee('bo-e2e-link2@example.com', 'FINANCE');
      const rows = await query<{ employee_id: string }>(
        `SELECT employee_id FROM employees WHERE login_email = 'bo-e2e-link2@example.com'`,
      );
      const stale = await issueActivationToken(rows[0].employee_id);
      expect(await status(stale, 'activation')).toBe('used');
      await request(server())
        .post('/api/auth/activate')
        .send({
          token: stale,
          password: 'other-pass-123',
          confirmPassword: 'other-pass-123',
        })
        .expect(410);
    });

    it('sends a fresh activation instead of a reset for a pending account', async () => {
      const { admin, employeeId, activation } = await createPending(
        'bo-e2e-link3@example.com',
      );
      const previous = process.env.APP_ENV;
      process.env.APP_ENV = 'SIT';
      let fresh: string;
      try {
        const res = await admin
          .post(`/api/admin/employees/${employeeId}/reset-password`)
          .send({ locale: 'en-GB' })
          .expect(200);
        expect(res.body.data.manualLink).toContain('/en-GB/activate?token=');
        fresh = tokenOf(res.body.data.manualLink);
      } finally {
        process.env.APP_ENV = previous;
      }
      expect(await status(activation, 'activation')).toBe('used');
      expect(await status(fresh, 'activation')).toBe('usable');
      await request(server())
        .post('/api/auth/activate')
        .send({
          token: fresh,
          password: 'fresh-pass-123',
          confirmPassword: 'fresh-pass-123',
        })
        .expect(200);
      expect(await status(fresh, 'activation')).toBe('used');
    });

    it('reports expired and unknown links without revealing the account', async () => {
      const { activation } = await createPending('bo-e2e-link4@example.com');
      await query(
        `UPDATE verification_tokens SET expires_at = now() - interval '1 minute'
          WHERE employee_id = (SELECT employee_id FROM employees WHERE login_email = 'bo-e2e-link4@example.com')`,
      );
      const res = await request(server())
        .get('/api/auth/token-status')
        .query({ token: activation, purpose: 'activation' })
        .expect(200);
      expect(res.body.data).toEqual({ status: 'expired' });
      expect(await status('not-a-real-token', 'reset')).toBe('invalid');
      expect(await status(activation, 'reset')).toBe('invalid');
      await request(server())
        .get('/api/auth/token-status')
        .query({ token: activation, purpose: 'other' })
        .expect(400);
    });
  });

  it('refuses a new password that equals the current one', async () => {
    const email = await ensureEmployee('bo-e2e-same@example.com', 'FINANCE');
    const agent = request.agent(server());
    await agent
      .post('/api/auth/sign-in')
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    const res = await agent
      .post('/api/auth/change-password')
      .send({
        currentPassword: E2E_PASSWORD,
        newPassword: E2E_PASSWORD,
        confirmPassword: E2E_PASSWORD,
      })
      .expect(400);
    expect(res.body.error.code).toBe('PASSWORD_SAME_AS_CURRENT');
    await agent.get('/api/session').expect(200);
  });

  it('matches % and _ literally in the email search and clamps huge pages', async () => {
    await ensureEmployee('bo-e2e-under_score@example.com', 'FINANCE');
    await ensureEmployee('bo-e2e-plain@example.com', 'FINANCE');
    const admin = await signInAs(app, 'ADMIN');
    const res = await admin
      .get('/api/admin/employees')
      .query({ email: '_score' })
      .expect(200);
    const emails = res.body.data.items.map(
      (item: { loginEmail: string }) => item.loginEmail,
    );
    expect(emails).toEqual(['bo-e2e-under_score@example.com']);
    const all = await admin
      .get('/api/admin/employees')
      .query({ email: '%' })
      .expect(200);
    expect(all.body.data.total).toBe(0);
    await admin
      .get('/api/admin/employees')
      .query({ page: '1e300' })
      .expect(200);
    await admin
      .get('/api/admin/employees')
      .query({ pageSize: 'Infinity' })
      .expect(200);
  });

  it('limits admin emails per administrator, not per office address', async () => {
    const admin = await signInAs(app, 'ADMIN');
    const previous = process.env.EMAIL_DELIVERY;
    process.env.EMAIL_DELIVERY = 'discard';
    try {
      for (let i = 0; i < 8; i += 1) {
        await admin
          .post('/api/admin/employees')
          .send({ email: `bo-e2e-bulk${i}@example.com`, role: 'FINANCE' })
          .expect(200);
      }
    } finally {
      process.env.EMAIL_DELIVERY = previous;
    }
  });

  it('does not echo JSON parser details or advertise the framework', async () => {
    const res = await request(server())
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/position|column/i);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
