import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';

/** ApiKeyGuard 单元测试：开关语义（§7 Phase 3 第 6 项注记） */
describe('ApiKeyGuard', () => {
  const makeContext = (
    headers: Record<string, string>,
    path = '/api/courses',
  ) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers, path }) }),
    }) as never;

  const makeConfig = (values: Record<string, string | undefined>) =>
    ({ get: (k: string) => values[k] }) as unknown as ConfigService;

  it('AUTH_ENABLED 未配置/false 时应直接放行（默认关闭）', () => {
    const guard = new ApiKeyGuard(makeConfig({}));
    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it('开启后：X-API-Key 匹配应放行', () => {
    const guard = new ApiKeyGuard(
      makeConfig({ AUTH_ENABLED: 'true', AUTH_TOKEN: 'secret' }),
    );
    expect(guard.canActivate(makeContext({ 'x-api-key': 'secret' }))).toBe(
      true,
    );
  });

  it('开启后：X-API-Key 缺失或不匹配应 401', () => {
    const guard = new ApiKeyGuard(
      makeConfig({ AUTH_ENABLED: 'true', AUTH_TOKEN: 'secret' }),
    );
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      guard.canActivate(makeContext({ 'x-api-key': 'wrong' })),
    ).toThrow(UnauthorizedException);
  });

  it('开启但未配置 AUTH_TOKEN 应一律 401（安全兜底）', () => {
    const guard = new ApiKeyGuard(makeConfig({ AUTH_ENABLED: 'true' }));
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('App Runner 健康检查不携带密钥也应放行', () => {
    const guard = new ApiKeyGuard(
      makeConfig({ AUTH_ENABLED: 'true', AUTH_TOKEN: 'secret' }),
    );
    expect(guard.canActivate(makeContext({}, '/api/health'))).toBe(true);
  });
});
