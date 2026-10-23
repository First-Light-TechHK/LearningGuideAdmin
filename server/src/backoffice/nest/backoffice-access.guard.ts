import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { decideEmployeeAccountAccess } from '../modules/rbac/access';
import { canViewMenu } from '../modules/rbac/permissions';
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

  constructor(config: ConfigService) {
    this.serviceGuard = new ApiKeyGuard(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<BackofficeRequest>();
    const access = routeAccess(request.method, request.path);

    if (access.kind === 'public') return true;
    if (access.kind === 'service')
      return this.serviceGuard.canActivate(context);

    const employee = await resolveSession(sessionToken(request));
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    request.employee = employee;

    if (access.kind === 'signedIn') return true;
    if (access.kind === 'employeeAdmin') {
      if (decideEmployeeAccountAccess(employee).allowed) return true;
      throw backofficeError('NOT_AUTHORISED', 'Admin only');
    }
    if (access.menus.some((menu) => canViewMenu(employee.role, menu)))
      return true;
    throw backofficeError(
      'NOT_AUTHORISED',
      'This menu is not available for your role',
    );
  }
}
