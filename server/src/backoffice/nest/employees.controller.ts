import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  parseEnabledCapabilities,
  type CapabilityId,
} from '../../common/capabilities';
import { DEFAULT_LOCALE, isLocale, type Locale } from '../lib/i18n/config';
import { consume } from '../lib/rateLimit';
import {
  ADMIN_EMAIL_SEND_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MINUTES,
} from '../lib/securityPolicy';
import {
  createEmployee,
  listEmployees,
  sendAdminPasswordReset,
  updateEmployee,
} from '../modules/employee-account/services/employeeAccount';
import {
  getEmployeeFeatures,
  saveEmployeeFeatures,
} from '../modules/rbac/employeeFeatures';
import { reissueActivation } from '../modules/user-authentication/services/passwordFlows';
import { asBody, readNumber, readOptionalString, readString } from './body';
import { backofficeError } from './errors';
import { appUrlFor, type BackofficeRequest, clientIp } from './request-context';

function admin(request: BackofficeRequest) {
  // BackofficeAccessGuard 已按 PRD §3.3 只放行 Admin
  const employee = request.employee;
  if (!employee)
    throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
  return employee;
}

/** 按操作者计数：同一办公室出口 IP 下的多位 Admin 互不占额度。 */
async function emailLimit(actorEmployeeId: string): Promise<void> {
  const key = `admin-email:${actorEmployeeId}`;
  const result = await consume(
    key,
    ADMIN_EMAIL_SEND_MAX_PER_WINDOW,
    RATE_LIMIT_WINDOW_MINUTES,
  );
  if (!result.allowed) {
    throw backofficeError(
      'RATE_LIMITED',
      'Too many emails, please try again later',
    );
  }
}

function linkLocale(body: Record<string, unknown>): Locale {
  const raw = readString(body, 'locale');
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/** PRD PORT-LST / PORT-NEW / PORT-EDT / PORT-ADM：员工账号管理（仅 Admin）。 */
@Controller('admin/employees')
export class BackofficeEmployeesController {
  constructor(private readonly config: ConfigService) {}

  /** 环境能力（ADMIN_CAPABILITIES）：功能开关永远不能越过它。 */
  private enabledCapabilities(): ReadonlySet<CapabilityId> {
    return parseEnabledCapabilities(
      this.config.get<string>('ADMIN_CAPABILITIES'),
    );
  }

  @Get()
  list(
    @Query('email') email?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return listEmployees({
      email,
      role,
      status,
      page: readNumber(page, 1),
      pageSize: readNumber(pageSize, 10),
    });
  }

  @Post()
  @HttpCode(200)
  async create(@Req() request: BackofficeRequest, @Body() raw: unknown) {
    const actor = admin(request);
    await emailLimit(actor.employeeId);
    const body = asBody(raw);
    const outcome = await createEmployee({
      rawEmail: readString(body, 'email'),
      role: readString(body, 'role'),
      accountStatus: readString(body, 'accountStatus'),
      actorEmployeeId: actor.employeeId,
      locale: linkLocale(body),
      appUrl: appUrlFor(request),
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Create rejected');
    return {
      employee: outcome.employee,
      delivery: outcome.delivery,
      manualLink: outcome.manualLink,
    };
  }

  @Patch(':employeeId')
  async update(
    @Req() request: BackofficeRequest,
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() raw: unknown,
  ) {
    const actor = admin(request);
    const body = asBody(raw);
    const outcome = await updateEmployee({
      employeeId,
      rawEmail: readOptionalString(body, 'email'),
      role: readOptionalString(body, 'role'),
      accountStatus: readOptionalString(body, 'accountStatus'),
      actorEmployeeId: actor.employeeId,
      locale: linkLocale(body),
      appUrl: appUrlFor(request),
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Update rejected');
    // 邮箱变更时会重发激活邮件：把投递结果与可手工转交的链接一并返回
    return {
      employee: outcome.employee,
      delivery: outcome.delivery,
      manualLink: outcome.manualLink,
    };
  }

  /** owner 2026-11-20：账号级功能权限（catalog + 显式 grants + effective）。 */
  @Get(':employeeId/features')
  async features(@Param('employeeId', new ParseUUIDPipe()) employeeId: string) {
    const view = await getEmployeeFeatures(
      employeeId,
      this.enabledCapabilities(),
    );
    if (!view) throw backofficeError('INVALID_INPUT', 'Employee not found');
    return view;
  }

  /**
   * 全量替换显式开关（缺省 = 继承角色）。只有 Admin（accounts FULL）能到这一步；
   * 最后一个可用 Admin 的账号管理不能被关掉（含给自己关掉），否则 PROTECTED_ADMIN_ACCOUNT。
   */
  @Put(':employeeId/features')
  async saveFeatures(
    @Req() request: BackofficeRequest,
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() raw: unknown,
  ) {
    const actor = admin(request);
    const body = asBody(raw);
    const outcome = await saveEmployeeFeatures({
      employeeId,
      grants: body.grants,
      actorEmployeeId: actor.employeeId,
      ipAddress: clientIp(request),
      enabledCapabilities: this.enabledCapabilities(),
    });
    if (!outcome.ok) {
      throw backofficeError(
        outcome.code,
        outcome.code === 'PROTECTED_ADMIN_ACCOUNT'
          ? 'The last usable Admin must keep account management'
          : 'Feature update rejected',
      );
    }
    return outcome.view;
  }

  @Post(':employeeId/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Req() request: BackofficeRequest,
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() raw: unknown,
  ) {
    const actor = admin(request);
    await emailLimit(actor.employeeId);
    const outcome = await sendAdminPasswordReset({
      employeeId,
      actorEmployeeId: actor.employeeId,
      locale: linkLocale(asBody(raw)),
      appUrl: appUrlFor(request),
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Reset rejected');
    return { delivery: outcome.delivery, manualLink: outcome.manualLink };
  }

  @Post(':employeeId/resend-activation')
  @HttpCode(200)
  async resendActivation(
    @Req() request: BackofficeRequest,
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() raw: unknown,
  ) {
    const actor = admin(request);
    await emailLimit(actor.employeeId);
    const outcome = await reissueActivation({
      employeeId,
      actorEmployeeId: actor.employeeId,
      locale: linkLocale(asBody(raw)),
      appUrl: appUrlFor(request),
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Resend rejected');
    return { delivery: outcome.delivery, manualLink: outcome.manualLink };
  }
}
