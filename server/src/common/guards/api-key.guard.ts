import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * 接口鉴权中间件（基础版骨架）——开发文档 §7 Phase 3 第 6 项注记（2026-10-14 拍板）：
 * - AUTH_ENABLED 默认 false（单人私有部署，本地开发不拦截）
 * - 开启后校验请求头 X-API-Key 等于环境变量 AUTH_TOKEN，不匹配返回 401 UNAUTHORIZED
 * - 完整用户认证（JWT/多用户/权限）推迟至 Phase 7，按 §12 事项 #1 再行确认
 * 全局注册见 AppModule（APP_GUARD）。
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly config: ConfigService) {
    if (this.config.get<string>('AUTH_ENABLED') === 'true' && !this.config.get<string>('AUTH_TOKEN')) {
      // 开启鉴权但未配置令牌：启动即告警，避免运行期所有请求静默 401 难以排查
      this.logger.warn('AUTH_ENABLED=true 但 AUTH_TOKEN 未配置，所有请求将被拒绝');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { headers: Record<string, string | string[] | undefined> }>();
    // App Runner 健康检查不带 X-API-Key，必须在鉴权之前放行。
    if (request.path === '/api/health') {
      return true;
    }
    if (this.config.get<string>('AUTH_ENABLED') !== 'true') {
      return true;
    }
    const expected = this.config.get<string>('AUTH_TOKEN');
    const provided = request.headers['x-api-key'];
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('未授权访问');
    }
    return true;
  }
}
