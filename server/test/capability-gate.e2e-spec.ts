import { Controller, Get, Logger } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { configureApp } from '../src/common/app-setup';
import { ModuleCapabilityGuard } from '../src/common/guards/module-capability.guard';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * 能力门 HTTP 级证明（不依赖数据库）：ADMIN_CAPABILITIES=course 时
 * - 课程管理与豁免路径正常穿透；
 * - 其余模块前缀返回 404 + 既有信封 MODULE_NOT_ENABLED；
 * - 未登记路径仍是既有的 NOT_FOUND（能力门不接管）。
 */

@Controller('backoffice/courses')
class FakeCoursesController {
  @Get()
  list() {
    return [{ id: 'c1' }];
  }
}

@Controller('helpdesk')
class FakeHelpdeskController {
  @Get('tickets')
  list() {
    return [{ id: 't1' }];
  }
}

@Controller('admin/employees')
class FakeAdminEmployeesController {
  @Get()
  list() {
    return [{ id: 'e1' }];
  }
}

@Controller('learning-access')
class FakeLearningAccessController {
  @Get()
  get() {
    return { enabled: true };
  }
}

@Controller('health')
class FakeHealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

async function createApp(raw: string | undefined): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [
      FakeCoursesController,
      FakeHelpdeskController,
      FakeAdminEmployeesController,
      FakeLearningAccessController,
      FakeHealthController,
    ],
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            key === 'ADMIN_CAPABILITIES' ? raw : process.env[key],
        },
      },
      { provide: APP_GUARD, useClass: ModuleCapabilityGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

/** supertest 接受的 server 类型（getHttpServer 在测试类型里是 any）。 */
function serverOf(app: INestApplication): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

describe('模块能力门（ADMIN_CAPABILITIES）HTTP 行为', () => {
  let app: INestApplication | undefined;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
  });

  it('ADMIN_CAPABILITIES=course：课程管理与健康检查放行', async () => {
    app = await createApp('course');
    const courses = await request(serverOf(app)).get('/api/backoffice/courses');
    expect(courses.status).toBe(200);
    expect(courses.body).toEqual({
      success: true,
      data: [{ id: 'c1' }],
      error: null,
      message: '操作成功',
    });
    const health = await request(serverOf(app)).get('/api/health');
    expect(health.status).toBe(200);
  });

  it('ADMIN_CAPABILITIES=course：未启用模块 404 + MODULE_NOT_ENABLED 信封', async () => {
    app = await createApp('course');
    const response = await request(serverOf(app)).get('/api/helpdesk/tickets');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      data: null,
      error: {
        code: 'MODULE_NOT_ENABLED',
        message: 'This module is not enabled in this environment',
      },
    });
  });

  it('accounts 是独立能力：course,accounts 放行员工账号，但不放行其余 Settings', async () => {
    app = await createApp('course,accounts');
    const employees = await request(serverOf(app)).get('/api/admin/employees');
    expect(employees.status).toBe(200);
    expect((employees.body as { data?: unknown }).data).toEqual([{ id: 'e1' }]);

    const learningAccess = await request(serverOf(app)).get(
      '/api/learning-access',
    );
    expect(learningAccess.status).toBe(404);
    expect(
      (learningAccess.body as { error?: { code?: string } }).error?.code,
    ).toBe('MODULE_NOT_ENABLED');

    // 账号管理不再被 settings 能力覆盖
    await app.close();
    app = await createApp('course');
    const blocked = await request(serverOf(app)).get('/api/admin/employees');
    expect(blocked.status).toBe(404);
    expect((blocked.body as { error?: { code?: string } }).error?.code).toBe(
      'MODULE_NOT_ENABLED',
    );

    await app.close();
    app = await createApp('settings');
    expect(
      (await request(serverOf(app)).get('/api/learning-access')).status,
    ).toBe(200);
    expect(
      (await request(serverOf(app)).get('/api/admin/employees')).status,
    ).toBe(404);
  });

  it('未配置 ADMIN_CAPABILITIES：全部模块照旧可访问', async () => {
    app = await createApp(undefined);
    const response = await request(serverOf(app)).get('/api/helpdesk/tickets');
    expect(response.status).toBe(200);
  });

  it('未登记路径仍走既有 404（不是 MODULE_NOT_ENABLED）', async () => {
    app = await createApp('course');
    const response = await request(serverOf(app)).get('/api/something-new');
    const body = response.body as {
      error: { code: string } | null;
    };
    expect(response.status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});
