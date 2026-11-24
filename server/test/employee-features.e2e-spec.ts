import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import type { SuccessResponse } from './helpers/http-response';
import { CourseFixtures } from './helpers/course-fixture';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { query } from '../src/backoffice/lib/db';
import {
  E2E_PASSWORD,
  ensureEmployee,
  resetRateLimits,
  signInAs,
} from './helpers/employee-session';
import type { EmployeeFeaturesView } from '../src/backoffice/modules/rbac/employeeFeatures';
import type { SessionPayload } from '../src/backoffice/nest/auth.controller';

/**
 * 账号级功能开关的 HTTP 合同（owner 2026-11-20）：
 * - 仅 Admin 可读/改他人的功能开关；
 * - PUT 全量替换、校验 key，写审计 before/after；
 * - GET /api/session 返回该员工生效的功能键，既有字段不变；
 * - 账号开关可加可减，环境能力永远优先。
 * 数据库用已 migrate 的全新库（DATABASE_URL），不是 mock。
 */
describe('Employee feature grants (e2e)', () => {
  let app: INestApplication<App>;

  // 启动完整 AppModule 与 scrypt 登录；与其它 e2e 并行时 5s 默认超时不够。
  jest.setTimeout(30_000);

  const TARGET_EMAIL = 'ef-e2e-target@example.com';
  const SESSION_EMAIL = 'ef-e2e-session@example.com';

  async function employeeIdOf(email: string): Promise<string> {
    const rows = await query<{ employee_id: string }>(
      `SELECT employee_id FROM employees WHERE login_email = $1`,
      [email],
    );
    return rows[0].employee_id;
  }

  async function cleanup(): Promise<void> {
    const rows = await query<{ employee_id: string }>(
      `SELECT employee_id FROM employees WHERE login_email LIKE 'ef-e2e-%'`,
    );
    const ids = rows.map((row) => row.employee_id);
    if (ids.length > 0) {
      await query(
        `DELETE FROM audit_events
          WHERE event_name = 'EMPLOYEE_FEATURES_CHANGED'
            AND target_employee_id = ANY($1::uuid[])`,
        [ids],
      );
      await query(`DELETE FROM employees WHERE employee_id = ANY($1::uuid[])`, [
        ids,
      ]);
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  beforeEach(() => resetRateLimits());

  const server = () => app.getHttpServer();

  it('lets an Admin read and replace another account’s switches, with an audit trail', async () => {
    await ensureEmployee(TARGET_EMAIL, 'FINANCE');
    const targetId = await employeeIdOf(TARGET_EMAIL);
    const admin = await signInAs(app, 'ADMIN');

    const put: SuccessResponse<EmployeeFeaturesView> = await admin
      .put(`/api/admin/employees/${targetId}/features`)
      .send({
        grants: [
          { feature: 'module.knowledge', allowed: false },
          { feature: 'course.publish', allowed: true },
        ],
      })
      .expect(200);
    expect(put.body.success).toBe(true);
    // 10 module + 5 课程动作；新建/删除只由角色矩阵控制，不在账号级目录里。
    expect(put.body.data.catalog.length).toBe(15);
    expect(put.body.data.catalog.map((entry) => entry.key)).not.toContain(
      'course.create',
    );
    expect(put.body.data.catalog.map((entry) => entry.key)).not.toContain(
      'course.delete',
    );
    expect(put.body.data.grants.map((row) => row.feature)).toEqual([
      'module.knowledge',
      'course.publish',
    ]);
    const byKey = new Map(
      put.body.data.effective.map((entry) => [entry.key, entry]),
    );
    expect(byKey.get('module.knowledge')?.allowed).toBe(false);
    expect(byKey.get('course.publish')?.allowed).toBe(true);
    expect(byKey.get('course.edit')?.allowed).toBe(false);

    const read: SuccessResponse<EmployeeFeaturesView> = await admin
      .get(`/api/admin/employees/${targetId}/features`)
      .expect(200);
    expect(read.body.data.grants).toEqual(put.body.data.grants);
    expect(read.body.data.effective).toEqual(put.body.data.effective);

    const audit = await query<{ old_value: string; new_value: string }>(
      `SELECT old_value, new_value FROM audit_events
        WHERE event_name = 'EMPLOYEE_FEATURES_CHANGED' AND target_employee_id = $1
        ORDER BY event_id DESC LIMIT 1`,
      [targetId],
    );
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0].old_value)).toEqual([]);
    expect(JSON.parse(audit[0].new_value)).toEqual([
      { feature: 'module.knowledge', allowed: false },
      { feature: 'course.publish', allowed: true },
    ]);

    // 清空 = 回到角色基线
    const cleared: SuccessResponse<EmployeeFeaturesView> = await admin
      .put(`/api/admin/employees/${targetId}/features`)
      .send({ grants: [] })
      .expect(200);
    expect(cleared.body.data.grants).toEqual([]);
    const clearedByKey = new Map(
      cleared.body.data.effective.map((entry) => [entry.key, entry]),
    );
    expect(clearedByKey.get('module.knowledge')?.allowed).toBe(true);
    expect(clearedByKey.get('course.publish')?.allowed).toBe(false);
  });

  it('rejects unknown keys, duplicates and malformed bodies', async () => {
    await ensureEmployee(TARGET_EMAIL, 'FINANCE');
    const targetId = await employeeIdOf(TARGET_EMAIL);
    const admin = await signInAs(app, 'ADMIN');

    for (const body of [
      { grants: [{ feature: 'module.unknown', allowed: true }] },
      { grants: [{ feature: 'course.publish', allowed: 'yes' }] },
      {
        grants: [
          { feature: 'course.publish', allowed: true },
          { feature: 'course.publish', allowed: false },
        ],
      },
      { grants: {} },
      {},
    ]) {
      const res = await admin
        .put(`/api/admin/employees/${targetId}/features`)
        .send(body)
        .expect(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'INVALID_INPUT',
      );
    }

    const unknown = await admin
      .get('/api/admin/employees/0192cccc-0000-7000-8000-00000000ffff/features')
      .expect(400);
    expect((unknown.body as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT',
    );
  });

  it('keeps feature administration Admin-only', async () => {
    await ensureEmployee(TARGET_EMAIL, 'FINANCE');
    const targetId = await employeeIdOf(TARGET_EMAIL);
    const finance = await signInAs(app, 'FINANCE');

    for (const call of [
      () => finance.get(`/api/admin/employees/${targetId}/features`),
      () =>
        finance
          .put(`/api/admin/employees/${targetId}/features`)
          .send({ grants: [] }),
    ]) {
      const res = await call().expect(403);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'NOT_AUTHORISED',
      );
    }
  });

  it('returns effective feature keys on GET /api/session without changing existing fields', async () => {
    await ensureEmployee(SESSION_EMAIL, 'FINANCE');
    const sessionId = await employeeIdOf(SESSION_EMAIL);
    const admin = await signInAs(app, 'ADMIN');
    await admin
      .put(`/api/admin/employees/${sessionId}/features`)
      .send({
        grants: [
          { feature: 'module.knowledge', allowed: false },
          { feature: 'course.publish', allowed: true },
        ],
      })
      .expect(200);

    const finance = request.agent(server());
    resetRateLimits();
    await finance
      .post('/api/auth/sign-in')
      .send({ email: SESSION_EMAIL, password: E2E_PASSWORD })
      .expect(200);
    const res: SuccessResponse<SessionPayload> = await finance
      .get('/api/session')
      .expect(200);
    const features = res.body.data.features;
    expect(features).toContain('course.publish');
    expect(features).not.toContain('module.knowledge');
    expect(features).toContain('course.view');
    expect(features).not.toContain('course.edit');
    // 既有字段保持原语义：menus 仍是角色可见菜单（前端再与 features 取交集）
    expect(res.body.data.menus).toContain('knowledge');
    expect(res.body.data.canManageEmployeeAccount).toBe(false);

    const adminSession: SuccessResponse<SessionPayload> = await admin
      .get('/api/session')
      .expect(200);
    expect(adminSession.body.data.features).toContain('module.accounts');
    expect(adminSession.body.data.canManageEmployeeAccount).toBe(true);

    // 清空后 session 立刻回到角色基线
    await admin
      .put(`/api/admin/employees/${sessionId}/features`)
      .send({ grants: [] })
      .expect(200);
    const after: SuccessResponse<SessionPayload> = await finance
      .get('/api/session')
      .expect(200);
    expect(after.body.data.features).toContain('module.knowledge');
    expect(after.body.data.features).not.toContain('course.publish');
  });

  it('enforces import / export / publish / edit / create switches end-to-end', async () => {
    const DESIGNER_EMAIL = 'ef-e2e-designer@example.com';
    await ensureEmployee(DESIGNER_EMAIL, 'GRAPHIC_DESIGNER');
    const designerId = await employeeIdOf(DESIGNER_EMAIL);
    const admin = await signInAs(app, 'ADMIN');
    const fixtures = new CourseFixtures(app, app.get(PrismaService));
    const course = await fixtures.createCourse(admin);

    const signInDesigner = async () => {
      resetRateLimits();
      const agent = request.agent(server());
      await agent
        .post('/api/auth/sign-in')
        .send({ email: DESIGNER_EMAIL, password: E2E_PASSWORD })
        .expect(200);
      return agent;
    };
    const setDesignerGrants = (grants: unknown) =>
      admin
        .put(`/api/admin/employees/${designerId}/features`)
        .send({ grants })
        .expect(200);

    try {
      // 角色基线：Graphic Designer 能看和改，不能新建/发布；导入导出独立开关打开
      await setDesignerGrants([
        { feature: 'course.import', allowed: true },
        { feature: 'course.export', allowed: true },
      ]);
      const designer = await signInDesigner();
      await designer.get('/api/backoffice/courses').expect(200);
      // 守卫放行后由业务校验/状态决定（非 403 = 动作开关已放行）
      const imported = await designer
        .post(`/api/backoffice/courses/${course.id}/import`)
        .send({});
      expect(imported.status).not.toBe(403);
      const exported = await designer
        .post(`/api/backoffice/courses/${course.id}/export`)
        .send({});
      expect(exported.status).not.toBe(403);
      const edited = await designer
        .put(`/api/backoffice/courses/${course.id}`)
        .send({});
      expect(edited.status).not.toBe(403);

      // 没有开关的动作仍按角色基线拒绝
      const publishDenied = await designer
        .post(`/api/backoffice/courses/${course.id}/publish`)
        .send({});
      expect(publishDenied.status).toBe(403);
      expect(
        (publishDenied.body as { error: { code: string } }).error.code,
      ).toBe('NOT_AUTHORISED');
      const createDenied = await designer
        .post('/api/backoffice/courses')
        .send({ title: 'nope' });
      expect(createDenied.status).toBe(403);

      // 单独放开发布：同一个账号立即生效
      await setDesignerGrants([
        { feature: 'course.import', allowed: true },
        { feature: 'course.export', allowed: true },
        { feature: 'course.publish', allowed: true },
      ]);
      const publishAllowed = await designer
        .post(`/api/backoffice/courses/${course.id}/publish`)
        .send({});
      expect(publishAllowed.status).not.toBe(403);

      // module.course=false 收紧整个课程菜单（即使动作开关还在）
      await setDesignerGrants([{ feature: 'module.course', allowed: false }]);
      const menuDenied = await designer.get('/api/backoffice/courses');
      expect(menuDenied.status).toBe(403);
    } finally {
      await fixtures.removeCourses();
    }
  });
});
