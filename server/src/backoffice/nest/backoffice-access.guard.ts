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
import { isDeployed } from '../lib/env';
import { decideEmployeeAccountAccess } from '../modules/rbac/access';
import { isActionAllowed } from '../modules/rbac/permissions';
import { resolveSession } from '../modules/user-authentication/services/session';
import { backofficeError } from './errors';
import { type BackofficeRequest, sessionToken } from './request-context';
import { routeAccess } from './route-access';

/**
 * 全局守卫：员工会话 + 菜单级权限（PRD §3.2 / §15.3）。
 * Portal 学员端接口（/api/user/**）继续用服务间密钥，规则沿用 ApiKeyGuard。
 */
@Injectable()
export class BackofficeAccessGuard implements CanActivate {
  private readonly serviceGuard: ApiKeyGuard;

  constructor(private readonly config: ConfigService) {
    this.serviceGuard = new ApiKeyGuard(config);
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
          this.config.get<string>('KS_SERVICE_TOKEN'),
          isDeployed(),
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
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid Bearer token is required',
      });
    }

    const employee = await resolveSession(sessionToken(request));
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    request.employee = employee;

    if (access.kind === 'signedIn') return true;
    if (access.kind === 'employeeAdmin') {
      if (decideEmployeeAccountAccess(employee).allowed) return true;
      throw backofficeError('NOT_AUTHORISED', 'Admin only');
    }
    // PRD §1.4：菜单可见之外，还要看该角色在此菜单的级别是否允许这种操作
    if (
      access.menus.some((menu) =>
        isActionAllowed(employee.role, menu, access.action),
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
