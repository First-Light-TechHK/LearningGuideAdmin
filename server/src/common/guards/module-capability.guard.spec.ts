import {
  Logger,
  NotFoundException,
  type ArgumentsHost,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import {
  MODULE_NOT_ENABLED,
  MODULE_NOT_ENABLED_MESSAGE,
  ModuleCapabilityGuard,
} from './module-capability.guard';

function guardFor(raw: string | undefined): ModuleCapabilityGuard {
  const config = {
    get: (key: string) => (key === 'ADMIN_CAPABILITIES' ? raw : undefined),
  } as unknown as ConfigService;
  const guard = new ModuleCapabilityGuard(config);
  guard.onModuleInit();
  return guard;
}

function contextFor(path: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path }),
    }),
  } as unknown as ExecutionContext;
}

describe('ModuleCapabilityGuard（ADMIN_CAPABILITIES 全局能力门）', () => {
  it('未配置时放行全部模块（既有环境行为不变）', () => {
    const guard = guardFor(undefined);
    expect(guard.canActivate(contextFor('/api/helpdesk/tickets'))).toBe(true);
    expect(guard.canActivate(contextFor('/api/backoffice/courses'))).toBe(true);
    expect(guard.canActivate(contextFor('/api/something-new'))).toBe(true);
  });

  it('course 配置下放行课程管理与豁免路径', () => {
    const guard = guardFor('course');
    for (const path of [
      '/api/backoffice/courses',
      '/api/backoffice/courses/abc/publish',
      '/api/health',
      '/api/session',
      '/api/auth/change-password',
      '/api/backoffice/environment',
      '/api/something-new',
    ]) {
      expect(guard.canActivate(contextFor(path))).toBe(true);
    }
  });

  it('禁用模块返回 404 MODULE_NOT_ENABLED，而不是 401/403', () => {
    const guard = guardFor('course');
    expect.assertions(5);
    try {
      guard.canActivate(contextFor('/api/helpdesk/tickets'));
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      const exception = error as NotFoundException;
      expect(exception.getStatus()).toBe(404);
      const body = exception.getResponse() as {
        code?: string;
        message?: string;
      };
      expect(body.code).toBe(MODULE_NOT_ENABLED);
      expect(body.message).toBe(MODULE_NOT_ENABLED_MESSAGE);
    }
    expect(MODULE_NOT_ENABLED).toBe('MODULE_NOT_ENABLED');
  });

  it('经全局异常过滤器输出既有信封 {success:false,data:null,error:{code,message}}', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const filter = new AllExceptionsFilter();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn<void, [Record<string, unknown>]>(),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    const guard = guardFor('course');
    let thrown: unknown;
    try {
      guard.canActivate(contextFor('/api/students'));
    } catch (error) {
      thrown = error;
    }
    filter.catch(thrown, host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json.mock.calls[0][0]).toEqual({
      success: false,
      data: null,
      error: {
        code: MODULE_NOT_ENABLED,
        message: MODULE_NOT_ENABLED_MESSAGE,
      },
    });
    jest.restoreAllMocks();
  });

  it('未知能力标识在启动阶段（onModuleInit）就失败', () => {
    expect(() => guardFor('course,marketing')).toThrow(
      /ADMIN_CAPABILITIES 含未知能力/,
    );
  });
});
