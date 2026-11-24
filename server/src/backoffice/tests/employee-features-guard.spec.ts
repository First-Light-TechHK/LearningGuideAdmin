import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';

import { configureApp } from '../../common/app-setup';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  type SessionEmployee,
} from '../contracts/employee';
import { resolveSession } from '../modules/user-authentication/services/session';
import { BackofficeAccessGuard } from '../nest/backoffice-access.guard';

/**
 * 守卫层证明（owner 2026-11-20）：
 * - 角色矩阵给基线，账号开关可加可减；
 * - 课程动作 import / export / publish / edit / view 各自独立；
 *   create / delete 没有账号开关，只由角色矩阵控制（旧词表 grant 读取时忽略）；
 * - 环境能力（ADMIN_CAPABILITIES）永远优先于账号开关；
 * - /api/admin/employees/** 归 accounts：默认 Admin-only，账号级开关可移除或降到只读。
 *
 * 会话与 grants 仓储都 mock 掉，不连数据库；这不是纯函数测试，走的是真实 Nest 管道与守卫。
 */
jest.mock('../modules/user-authentication/services/session', () => ({
  resolveSession: jest.fn(),
}));

// 每个用例都要启动一次真实 Nest 管道；并行跑全量单测时 5s 默认超时会被 CPU 竞争打穿。
jest.setTimeout(30_000);

const mockGrantMaps = new Map<string, Map<string, boolean>>();
jest.mock('../repositories/featureGrantRepository', () => ({
  mapForEmployee: jest.fn((employeeId: string) =>
    Promise.resolve(
      mockGrantMaps.get(employeeId) ?? new Map<string, boolean>(),
    ),
  ),
}));

@Controller()
class FakeBackofficeController {
  @Get('backoffice/courses') listCourses() {
    return { ok: true };
  }
  @Post('backoffice/courses')
  @HttpCode(200)
  createCourse() {
    return { ok: true };
  }
  @Put('backoffice/courses/:id')
  @HttpCode(200)
  editCourse() {
    return { ok: true };
  }
  @Delete('backoffice/courses/:id')
  @HttpCode(200)
  deleteCourse() {
    return { ok: true };
  }
  @Post('backoffice/courses/:id/publish')
  @HttpCode(200)
  publishCourse() {
    return { ok: true };
  }
  @Post('backoffice/courses/:id/import')
  @HttpCode(200)
  importCourse() {
    return { ok: true };
  }
  @Post('backoffice/courses/import')
  @HttpCode(200)
  importWholeCourse() {
    return { ok: true };
  }
  @Post('backoffice/courses/:id/export')
  @HttpCode(200)
  exportCourse() {
    return { ok: true };
  }
  @Get('backoffice/operations/popular-courses') operations() {
    return { ok: true };
  }
  @Get('courses') listKnowledgeCourses() {
    return { ok: true };
  }
  @Get('helpdesk/tickets') tickets() {
    return { ok: true };
  }
  @Get('admin/employees') listEmployees() {
    return { ok: true };
  }
  @Patch('admin/employees/:id') updateEmployee() {
    return { ok: true };
  }
  @Get('admin/employees/:id/features') readFeatures() {
    return { ok: true };
  }
  @Put('admin/employees/:id/features')
  @HttpCode(200)
  saveFeatures() {
    return { ok: true };
  }
}

function employeeFor(role: EmployeeRole): SessionEmployee {
  return {
    employeeId: `emp-${role}`,
    loginEmail: `${role.toLowerCase()}@example.com`,
    role,
    displayName: role.toLowerCase(),
    accountStatus: 'ACTIVE',
    emailVerification: 'VERIFIED',
    displayStatus: 'Active',
    isBootstrapAdmin: false,
  };
}

function grant(role: EmployeeRole, entries: Array<[string, boolean]>): void {
  mockGrantMaps.set(`emp-${role}`, new Map(entries));
}

async function createApp(
  rawCapabilities: string | undefined,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [FakeBackofficeController],
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            key === 'ADMIN_CAPABILITIES' ? rawCapabilities : process.env[key],
        },
      },
      { provide: APP_GUARD, useClass: BackofficeAccessGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('BackofficeAccessGuard: account feature grants', () => {
  let app: INestApplication | undefined;

  beforeEach(() => {
    mockGrantMaps.clear();
    (resolveSession as jest.Mock).mockImplementation((token?: string) =>
      Promise.resolve(
        token && (EMPLOYEE_ROLES as readonly string[]).includes(token)
          ? employeeFor(token as EmployeeRole)
          : null,
      ),
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const server = (): Server => app!.getHttpServer() as Server;
  const as = (role: EmployeeRole) => `lgbo_session=${role}`;

  async function expectStatus(
    role: EmployeeRole,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    status: number,
  ): Promise<void> {
    const response = await request(server())
      [method](path)
      .set('Cookie', as(role));
    if (response.status !== status) {
      throw new Error(
        `${method.toUpperCase()} ${path} as ${role}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
  }

  it('inherits the role matrix when no account switch exists', async () => {
    app = await createApp(undefined);
    await expectStatus(
      'ADMIN',
      'post',
      '/api/backoffice/courses/c1/publish',
      200,
    );
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'put',
      '/api/backoffice/courses/c1',
      200,
    );
    for (const path of [
      '/api/backoffice/courses',
      '/api/backoffice/courses/c1/publish',
      '/api/backoffice/courses/c1/import',
      '/api/backoffice/courses/c1/export',
    ]) {
      await expectStatus('GRAPHIC_DESIGNER', 'post', path, 403);
    }
    await expectStatus('COURSE_CREATOR', 'get', '/api/backoffice/courses', 200);
    await expectStatus(
      'COURSE_CREATOR',
      'put',
      '/api/backoffice/courses/c1',
      403,
    );
  });

  it('opens import, export, publish and edit independently', async () => {
    app = await createApp(undefined);
    grant('GRAPHIC_DESIGNER', [['course.import', true]]);
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'post',
      '/api/backoffice/courses/c1/import',
      200,
    );
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'post',
      '/api/backoffice/courses/c1/export',
      403,
    );
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'post',
      '/api/backoffice/courses/c1/publish',
      403,
    );

    grant('COURSE_CREATOR', [['course.export', true]]);
    await expectStatus(
      'COURSE_CREATOR',
      'post',
      '/api/backoffice/courses/c1/export',
      200,
    );
    await expectStatus(
      'COURSE_CREATOR',
      'post',
      '/api/backoffice/courses/c1/import',
      403,
    );

    grant('COURSE_CREATOR', [['course.edit', true]]);
    await expectStatus(
      'COURSE_CREATOR',
      'put',
      '/api/backoffice/courses/c1',
      200,
    );

    grant('GRAPHIC_DESIGNER', [['course.publish', true]]);
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'post',
      '/api/backoffice/courses/c1/publish',
      200,
    );
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'post',
      '/api/backoffice/courses',
      403,
    );

    // 新建/删除不再有账号级开关（permissions.md：新建/删除只由角色矩阵控制）。
    // 存量 grant 行（旧词表）读取时按未知 key 忽略：既不能给 View/Edit 放行，也不能收回 Full。
    grant('COURSE_CREATOR', [['course.create', true]]);
    await expectStatus(
      'COURSE_CREATOR',
      'post',
      '/api/backoffice/courses',
      403,
    );

    await expectStatus('ADMIN', 'delete', '/api/backoffice/courses/c1', 200);
    grant('ADMIN', [['course.delete', false]]);
    await expectStatus('ADMIN', 'delete', '/api/backoffice/courses/c1', 200);
    grant('GRAPHIC_DESIGNER', [['course.delete', true]]);
    await expectStatus(
      'GRAPHIC_DESIGNER',
      'delete',
      '/api/backoffice/courses/c1',
      403,
    );
    await expectStatus(
      'OPERATION_ADMIN',
      'delete',
      '/api/backoffice/courses/c1',
      200,
    );
  });

  it('lets a denied action switch tighten even an Admin', async () => {
    app = await createApp(undefined);
    grant('ADMIN', [['course.publish', false]]);
    await expectStatus(
      'ADMIN',
      'post',
      '/api/backoffice/courses/c1/publish',
      403,
    );
    await expectStatus('ADMIN', 'put', '/api/backoffice/courses/c1', 200);

    grant('ADMIN', [
      ['module.course', false],
      ['course.publish', true],
    ]);
    await expectStatus('ADMIN', 'get', '/api/backoffice/courses', 403);
    await expectStatus(
      'ADMIN',
      'post',
      '/api/backoffice/courses/c1/publish',
      403,
    );
  });

  it('lets an allowed module switch lift a role NONE to VIEW, and no further', async () => {
    app = await createApp(undefined);
    await expectStatus('OPERATION_ADMIN', 'get', '/api/courses', 403);
    grant('OPERATION_ADMIN', [['module.knowledge', true]]);
    await expectStatus('OPERATION_ADMIN', 'get', '/api/courses', 200);
  });

  it('keeps the operations switch independent from Course content', async () => {
    app = await createApp(undefined);
    grant('ADMIN', [['module.operations', false]]);
    await expectStatus(
      'ADMIN',
      'get',
      '/api/backoffice/operations/popular-courses',
      403,
    );
    await expectStatus('ADMIN', 'get', '/api/backoffice/courses', 200);
    grant('ADMIN', [['module.operations', true]]);
    await expectStatus(
      'ADMIN',
      'get',
      '/api/backoffice/operations/popular-courses',
      200,
    );
  });

  it('environment capability always beats an allowed account switch', async () => {
    app = await createApp('course');
    grant('ADMIN', [['module.helpdesk', true]]);
    await expectStatus('ADMIN', 'get', '/api/helpdesk/tickets', 403);
    await expectStatus('ADMIN', 'get', '/api/backoffice/courses', 200);
    await expectStatus(
      'ADMIN',
      'get',
      '/api/backoffice/operations/popular-courses',
      403,
    );
  });

  it('keeps employee accounts Admin-only by default', async () => {
    app = await createApp(undefined);
    await expectStatus('FINANCE', 'get', '/api/admin/employees', 403);
    await expectStatus('FINANCE', 'patch', '/api/admin/employees/e1', 403);
    await expectStatus('ADMIN', 'get', '/api/admin/employees', 200);
    await expectStatus('ADMIN', 'patch', '/api/admin/employees/e1', 200);
    await expectStatus('ADMIN', 'get', '/api/admin/employees/e1/features', 200);
    await expectStatus('ADMIN', 'put', '/api/admin/employees/e1/features', 200);
  });

  it('accounts grants cannot widen account management beyond Admin (PRD §3.3)', async () => {
    app = await createApp(undefined);
    grant('FINANCE', [['module.accounts', true]]);
    // 账号开关只能收紧，不能把员工账号管理授给非 Admin
    await expectStatus('FINANCE', 'get', '/api/admin/employees', 403);
    await expectStatus('FINANCE', 'patch', '/api/admin/employees/e1', 403);
    await expectStatus(
      'FINANCE',
      'get',
      '/api/admin/employees/e1/features',
      403,
    );
    await expectStatus(
      'FINANCE',
      'put',
      '/api/admin/employees/e1/features',
      403,
    );
  });

  it('an accounts denial removes account management from an Admin', async () => {
    app = await createApp(undefined);
    grant('ADMIN', [['module.accounts', false]]);
    await expectStatus('ADMIN', 'get', '/api/admin/employees', 403);
    await expectStatus('ADMIN', 'get', '/api/admin/employees/e1/features', 403);
    await expectStatus('ADMIN', 'put', '/api/admin/employees/e1/features', 403);
  });

  it('accounts capability is enforced by the environment too', async () => {
    app = await createApp('course,accounts');
    await expectStatus('ADMIN', 'get', '/api/admin/employees', 200);
    await app?.close();
    app = await createApp('course');
    await expectStatus('ADMIN', 'get', '/api/admin/employees', 403);
  });

  it('rejects signed-out calls before any feature decision', async () => {
    app = await createApp(undefined);
    await request(server()).get('/api/backoffice/courses').expect(401);
    await request(server()).get('/api/admin/employees').expect(401);
  });
});
