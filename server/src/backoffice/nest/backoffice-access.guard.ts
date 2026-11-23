import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import {
  checkHelpdeskIntegrationToken,
  helpdeskIntegrationToken,
} from '../../common/guards/helpdesk-integration-auth';
import { serviceTokenAllows } from '../../common/guards/service-token';
import {
  parseEnabledCapabilities,
  type CapabilityId,
} from '../../common/capabilities';
import { isDeployed } from '../lib/env';
import { decideEmployeeAccountAccess } from '../modules/rbac/access';
import {
  effectiveModuleLevel,
  isCourseActionFeatureAllowed,
  isMenuActionAllowed,
  isModuleFeatureAllowed,
  isModuleFeatureKey,
  type CourseActionFeatureKey,
} from '../modules/rbac/features';
import { grantsForRequest } from '../modules/rbac/employeeFeatures';
import { resolveSession } from '../modules/user-authentication/services/session';
import { backofficeError } from './errors';
import { type BackofficeRequest, sessionToken } from './request-context';
import { routeAccess } from './route-access';

/**
 * 全局守卫：员工会话 + 菜单级权限（PRD §3.2 / §15.3）。
 * Portal 学员端接口（/api/user/**）继续用服务间密钥，规则沿用 ApiKeyGuard。
 *
 * owner 2026-11-20：解析员工后加载该员工的账号级功能开关（单请求内缓存），
 * 最终判定 = 环境能力 ∩ 角色矩阵 ∩ 账号开关，规则集中在 modules/rbac/features.ts。
 */
@Injectable()
export class BackofficeAccessGuard implements CanActivate {
  private readonly serviceGuard: ApiKeyGuard;
  private readonly enabledCapabilities: ReadonlySet<CapabilityId>;

  constructor(private readonly config: ConfigService) {
    this.serviceGuard = new ApiKeyGuard(config);
    // 与 ModuleCapabilityGuard 同一个解析器：未知能力在启动期已 fail-fast
    this.enabledCapabilities = parseEnabledCapabilities(
      config.get<string>('ADMIN_CAPABILITIES'),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<BackofficeRequest>();
    const access = routeAccess(request.method, request.path);

    if (access.kind === 'public') return true;
    if (access.kind === 'service')
      return this.serviceGuard.canActivate(context);
    if (access.kind === 'internal') {
      if (
        serviceTokenAllows(
          request.headers.authorization,
          // Portal 的 KS_TUTOR_API_KEY 必须等于这里接受的值：优先显式的
          // KS_SERVICE_TOKEN，未配置时退回 AUTH_TOKEN，避免两套令牌并存。
          this.config.get<string>('KS_SERVICE_TOKEN')?.trim() ||
            this.config.get<string>('AUTH_TOKEN'),
          isDeployed(),
          request.headers['x-api-key'],
        )
      )
        return true;
      throw new UnauthorizedException({
        code: 'SERVICE_TOKEN_INVALID',
        message: 'Service token required',
      });
    }

    if (access.kind === 'helpdeskIntegration') {
      // 不看员工会话：Portal 只带 Bearer ADMIN_HELPDESK_TOKEN（每次现读）
      const result = checkHelpdeskIntegrationToken(
        request.headers.authorization,
        helpdeskIntegrationToken(),
      );
      if (result === 'ok') return true;
      if (result === 'disabled')
        throw new HttpException(
          {
            code: 'integration_disabled',
            message: 'Helpdesk integration is not configured',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      // 与 Portal 集成接口同一个 401 代码（RFC 6750 §3.1 invalid_token）
      throw new UnauthorizedException({
        code: 'invalid_token',
        message: 'A valid Bearer token is required',
      });
    }

    const employee = await resolveSession(sessionToken(request));
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    request.employee = employee;

    // 解析会话后加载账号开关：守卫与 /api/session 共用（单请求内只查一次）
    const grants = await grantsForRequest(request, employee.employeeId);

    if (access.kind === 'signedIn') return true;
    if (access.kind === 'employeeAdmin') {
      if (decideEmployeeAccountAccess(employee).allowed) return true;
      throw backofficeError('NOT_AUTHORISED', 'Admin only');
    }
    if (access.kind === 'accountsAdmin') {
      const level = effectiveModuleLevel(
        employee.role,
        'module.accounts',
        grants,
        this.enabledCapabilities,
      );
      const allowed =
        access.action === 'VIEW' ? level !== 'NONE' : level === 'FULL';
      if (allowed) return true;
      throw backofficeError(
        'NOT_AUTHORISED',
        'Employee account management is not available for this account',
      );
    }
    // PRD §3/§11.3：Notification Configuration 只有 Admin 角色可用，其余走菜单检查。
    if (access.adminOnly && !decideEmployeeAccountAccess(employee).allowed)
      throw backofficeError(
        'NOT_AUTHORISED',
        'Notification Configuration is available to Admin only',
      );
    // PRD §1.4：菜单可见之外，还要看该角色/账号开关在此菜单的级别是否允许这种操作
    if (
      access.feature &&
      isModuleFeatureKey(access.feature) &&
      !isModuleFeatureAllowed(
        access.feature,
        employee.role,
        grants,
        this.enabledCapabilities,
      )
    ) {
      throw backofficeError(
        'NOT_AUTHORISED',
        'This module is not available for your account',
      );
    }
    if (
      access.featuresAny &&
      !access.featuresAny.some((feature) =>
        isCourseActionFeatureAllowed(
          feature as CourseActionFeatureKey,
          employee.role,
          grants,
          this.enabledCapabilities,
        ),
      )
    ) {
      throw backofficeError(
        'NOT_AUTHORISED',
        'This action requires import or export access',
      );
    }
    if (
      access.menus.some((menu) =>
        isMenuActionAllowed(
          employee.role,
          menu,
          access.action,
          grants,
          this.enabledCapabilities,
        ),
      )
    )
      return true;
    throw backofficeError(
      'NOT_AUTHORISED',
      access.action === 'VIEW'
        ? 'This menu is not available for your role'
        : 'Your role can only view this menu',
    );
  }
}
