import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ALL_CAPABILITIES,
  parseEnabledCapabilities,
  capabilityGateAllows,
  type CapabilityId,
} from '../capabilities';

/** 能力门的稳定错误码（前端与 e2e 依赖它识别“模块未启用”）。 */
export const MODULE_NOT_ENABLED = 'MODULE_NOT_ENABLED';
export const MODULE_NOT_ENABLED_MESSAGE =
  'This module is not enabled in this environment';

/**
 * 全局能力门（ADMIN_CAPABILITIES）：禁用能力前缀下的请求一律 404 + 统一信封。
 *
 * 注册在 BackofficeAccessGuard 之前（见 AppModule providers 顺序），
 * 禁用模块不会先暴露 401/403 的差别。前缀表与解析逻辑全部在 ../capabilities，
 * 这里只做请求接线；未登记路径放行给既有守卫与 404。
 */
@Injectable()
export class ModuleCapabilityGuard implements CanActivate, OnModuleInit {
  private enabled: ReadonlySet<CapabilityId> = ALL_CAPABILITIES;

  constructor(private readonly config: ConfigService) {
    // ConfigModule.forRoot 在模块元数据构建时就同步加载 .env，这里读到的已是最终值；
    // onModuleInit 再解析一次，兜住任何更晚加载的配置来源。
    this.reload();
  }

  onModuleInit(): void {
    this.reload();
  }

  private reload(): void {
    this.enabled = parseEnabledCapabilities(
      this.config.get<string>('ADMIN_CAPABILITIES'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ path?: string; url?: string }>();
    const path = request.path ?? request.url ?? '';
    if (capabilityGateAllows(path, this.enabled)) return true;
    throw new NotFoundException({
      code: MODULE_NOT_ENABLED,
      message: MODULE_NOT_ENABLED_MESSAGE,
    });
  }
}
