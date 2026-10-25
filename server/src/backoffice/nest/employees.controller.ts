import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import { DEFAULT_LOCALE, isLocale, type Locale } from '../lib/i18n/config';
import { consume } from '../lib/rateLimit';
import {
  EMAIL_SEND_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MINUTES,
} from '../lib/securityPolicy';
import {
  createEmployee,
  listEmployees,
  sendAdminPasswordReset,
  updateEmployee,
} from '../modules/employee-account/services/employeeAccount';
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

function emailLimit(request: BackofficeRequest, action: string): void {
  const key = `${action}:${clientIp(request)}`;
  if (
    !consume(key, EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES).allowed
  ) {
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
    emailLimit(request, 'employee-create');
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

  @Post(':employeeId/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Req() request: BackofficeRequest,
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() raw: unknown,
  ) {
    const actor = admin(request);
    emailLimit(request, 'admin-reset');
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
    emailLimit(request, 'resend-activation');
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
