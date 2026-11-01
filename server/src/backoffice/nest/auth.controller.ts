import { createHash, timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { normaliseEmail, type SessionEmployee } from '../contracts/employee';
import { isDeployed } from '../lib/env';
import { DEFAULT_LOCALE, isLocale, type Locale } from '../lib/i18n/config';
import { clear, consume, peek } from '../lib/rateLimit';
import {
  EMAIL_CHECK_MAX_PER_WINDOW,
  EMAIL_SEND_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MINUTES,
  SIGN_IN_MAX_PER_WINDOW,
  TOKEN_STATUS_MAX_PER_WINDOW,
} from '../lib/securityPolicy';
import {
  canAccessEmployeeAccount,
  DEFAULT_LANDING_MENU,
  visibleMenus,
  visibleSettingsSubs,
  type MenuKey,
  type SettingsSubKey,
} from '../modules/rbac/permissions';
import {
  createFirstAdmin,
  employeeCount,
} from '../modules/user-authentication/services/bootstrap';
import {
  activateWithToken,
  changeOwnPassword,
  inspectLinkStatus,
  requestPasswordReset,
  resetWithToken,
} from '../modules/user-authentication/services/passwordFlows';
import { destroySession } from '../modules/user-authentication/services/session';
import {
  checkEmployeeEmail,
  signIn,
} from '../modules/user-authentication/services/signIn';
import { tryRecordAuditEvent } from '../repositories/auditRepository';
import * as preferencesRepository from '../repositories/preferencesRepository';
import { asBody, readString } from './body';
import {
  clearSessionCookie,
  LOCALE_COOKIE_NAME,
  setLocaleCookie,
  setSessionCookie,
} from './cookies';
import { backofficeError } from './errors';
import {
  appUrlFor,
  type BackofficeRequest,
  clientIp,
  readCookie,
  sessionToken,
  userAgent,
} from './request-context';

export type SessionPayload = {
  employee: Pick<
    SessionEmployee,
    | 'employeeId'
    | 'loginEmail'
    | 'displayName'
    | 'role'
    | 'displayStatus'
    | 'isBootstrapAdmin'
  >;
  locale: Locale;
  menus: MenuKey[];
  settings: SettingsSubKey[];
  canManageEmployeeAccount: boolean;
  landingMenu: MenuKey;
  /** PORT-NAV-003：按账号恢复侧栏折叠状态 */
  sidebarState: 'expanded' | 'collapsed';
};

async function limit(key: string, max: number): Promise<void> {
  if (!(await consume(key, max, RATE_LIMIT_WINDOW_MINUTES)).allowed) {
    throw backofficeError(
      'RATE_LIMITED',
      'Too many attempts, please try again later',
    );
  }
}

function bodyLocale(body: Record<string, unknown>): Locale {
  const raw = readString(body, 'locale');
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/** PRD PORT-LOG / PORT-ACT / PORT-PWD / PORT-NAV-006：员工登录、激活、找回密码与语言偏好。 */
@Controller()
export class BackofficeAuthController {
  @Post('auth/email-check')
  @HttpCode(200)
  async emailCheck(@Req() request: Request, @Body() raw: unknown) {
    await limit(`email-check:${clientIp(request)}`, EMAIL_CHECK_MAX_PER_WINDOW);
    return checkEmployeeEmail(readString(asBody(raw), 'email'));
  }

  @Post('auth/sign-in')
  @HttpCode(200)
  async signIn(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() raw: unknown,
  ) {
    const ip = clientIp(request);
    const body = asBody(raw);
    // 只数失败：按 IP 一个窗口，按 IP+邮箱 再一个窗口。不单按邮箱计数，
    // 否则别人换着 IP 输错 10 次就能把某位员工锁在门外。
    const ipKey = `sign-in:${ip}`;
    const pairKey = `sign-in-pair:${ip}:${normaliseEmail(readString(body, 'email'))}`;
    for (const key of [ipKey, pairKey]) {
      if (!(await peek(key, SIGN_IN_MAX_PER_WINDOW)).allowed) {
        throw backofficeError(
          'RATE_LIMITED',
          'Too many attempts, please try again later',
        );
      }
    }
    const outcome = await signIn({
      rawEmail: readString(body, 'email'),
      password: readString(body, 'password'),
      ipAddress: ip,
      userAgent: userAgent(request),
    });
    if (!outcome.ok) {
      if (
        outcome.code === 'INVALID_CREDENTIALS' ||
        outcome.code === 'INVALID_INPUT'
      ) {
        await consume(ipKey, SIGN_IN_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES);
        await consume(
          pairKey,
          SIGN_IN_MAX_PER_WINDOW,
          RATE_LIMIT_WINDOW_MINUTES,
        );
      }
      throw backofficeError(outcome.code, 'Sign-in rejected');
    }
    await clear(pairKey);

    // PORT-NAV-006：账号级语言偏好优先，其次本次页面语言
    const stored = await preferencesRepository
      .findLocale(outcome.employee.employeeId)
      .catch(() => null);
    const cookieLocale = readCookie(request, LOCALE_COOKIE_NAME);
    const locale: Locale = isLocale(stored)
      ? stored
      : isLocale(cookieLocale)
        ? cookieLocale
        : bodyLocale(body);

    setSessionCookie(response, outcome.token, outcome.maxAgeSeconds);
    setLocaleCookie(response, locale);
    return { employee: outcome.employee, locale };
  }

  @Post('auth/sign-out')
  @HttpCode(200)
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await destroySession(sessionToken(request));
    clearSessionCookie(response);
    return { signedOut: true };
  }

  @Post('auth/activate')
  @HttpCode(200)
  async activate(@Req() request: Request, @Body() raw: unknown) {
    const body = asBody(raw);
    const outcome = await activateWithToken({
      rawToken: readString(body, 'token'),
      password: readString(body, 'password'),
      confirmPassword: readString(body, 'confirmPassword'),
      ipAddress: clientIp(request),
      locale: bodyLocale(body),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Activation rejected');
    return { activated: true };
  }

  /** PORT-ACT-003：页面打开时先判断链接是否可用，过期/已用不显示表单。 */
  @Get('auth/token-status')
  async tokenStatus(
    @Req() request: Request,
    @Query('token') token?: string,
    @Query('purpose') purpose?: string,
  ) {
    await limit(
      `token-status:${clientIp(request)}`,
      TOKEN_STATUS_MAX_PER_WINDOW,
    );
    if (purpose !== 'activation' && purpose !== 'reset')
      throw backofficeError('INVALID_INPUT', 'Unsupported purpose');
    const status = await inspectLinkStatus(
      typeof token === 'string' ? token : '',
      purpose === 'activation' ? 'ACTIVATION' : 'PASSWORD_RESET',
    );
    return { status };
  }

  @Post('auth/forgot-password')
  @HttpCode(200)
  async forgotPassword(@Req() request: Request, @Body() raw: unknown) {
    await limit(
      `forgot-password:${clientIp(request)}`,
      EMAIL_SEND_MAX_PER_WINDOW,
    );
    const body = asBody(raw);
    limit(
      `forgot-password-email:${normaliseEmail(readString(body, 'email'))}`,
      EMAIL_SEND_MAX_PER_WINDOW,
    );
    // PORT-PWD-001：结果对外一致，避免账号枚举
    await requestPasswordReset({
      rawEmail: readString(body, 'email'),
      ipAddress: clientIp(request),
      locale: bodyLocale(body),
      appUrl: appUrlFor(request),
    });
    return { requested: true };
  }

  @Post('auth/reset-password')
  @HttpCode(200)
  async resetPassword(@Req() request: Request, @Body() raw: unknown) {
    const body = asBody(raw);
    const outcome = await resetWithToken({
      rawToken: readString(body, 'token'),
      password: readString(body, 'password'),
      confirmPassword: readString(body, 'confirmPassword'),
      ipAddress: clientIp(request),
      locale: bodyLocale(body),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Reset rejected');
    return { reset: true };
  }

  @Post('auth/change-password')
  @HttpCode(200)
  async changePassword(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() raw: unknown,
  ) {
    const employee = request.employee;
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    const body = asBody(raw);
    const outcome = await changeOwnPassword({
      employee,
      currentPassword: readString(body, 'currentPassword'),
      newPassword: readString(body, 'newPassword'),
      confirmPassword: readString(body, 'confirmPassword'),
      ipAddress: clientIp(request),
      locale: bodyLocale(body),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Change rejected');
    // PORT-PWD-006：改密后所有会话失效，必须重新登录
    clearSessionCookie(response);
    return { changed: true };
  }

  /** 首个管理员：一个员工都没有时才可用（见 services/bootstrap）。 */
  @Get('auth/setup')
  async setupState() {
    const required = (await employeeCount()) === 0;
    return { required, serviceKeyRequired: required && setupNeedsServiceKey() };
  }

  @Post('auth/setup')
  @HttpCode(200)
  async setup(@Req() request: Request, @Body() raw: unknown) {
    await limit(`setup:${clientIp(request)}`, SIGN_IN_MAX_PER_WINDOW);
    const body = asBody(raw);
    if (!setupKeyAccepted(readString(body, 'serviceKey'))) {
      throw backofficeError('NOT_AUTHORISED', 'Service key required');
    }
    const outcome = await createFirstAdmin({
      rawEmail: readString(body, 'email'),
      password: readString(body, 'password'),
      confirmPassword: readString(body, 'confirmPassword'),
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) throw backofficeError(outcome.code, 'Setup rejected');
    return { created: true };
  }

  @Get('session')
  async session(
    @Req() request: BackofficeRequest,
    @Query('locale') requested?: string,
  ): Promise<SessionPayload> {
    const employee = request.employee;
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    const cookieLocale = readCookie(request, LOCALE_COOKIE_NAME);
    const locale: Locale = isLocale(requested)
      ? requested
      : isLocale(cookieLocale)
        ? cookieLocale
        : DEFAULT_LOCALE;
    // PORT-NAV-003：折叠状态跨登录保留
    const sidebarState = await preferencesRepository
      .findSidebarState(employee.employeeId)
      .catch(() => null);
    return {
      employee: {
        employeeId: employee.employeeId,
        loginEmail: employee.loginEmail,
        displayName: employee.displayName,
        role: employee.role,
        displayStatus: employee.displayStatus,
        isBootstrapAdmin: employee.isBootstrapAdmin,
      },
      locale,
      menus: visibleMenus(employee.role),
      settings: visibleSettingsSubs(employee.role),
      canManageEmployeeAccount: canAccessEmployeeAccount(employee.role),
      landingMenu: DEFAULT_LANDING_MENU,
      sidebarState: sidebarState === 'collapsed' ? 'collapsed' : 'expanded',
    };
  }

  /** PORT-NAV-003：折叠状态按账号落库。 */
  @Post('preferences/sidebar')
  @HttpCode(200)
  async saveSidebarState(
    @Req() request: BackofficeRequest,
    @Body() raw: unknown,
  ) {
    const employee = request.employee;
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    const state = readString(asBody(raw), 'state');
    if (state !== 'expanded' && state !== 'collapsed')
      throw backofficeError('INVALID_INPUT', 'Unsupported sidebar state');
    await preferencesRepository.upsertSidebarState(employee.employeeId, state);
    return { state };
  }

  @Post('preferences/locale')
  @HttpCode(200)
  async saveLocale(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() raw: unknown,
  ) {
    const employee = request.employee;
    if (!employee)
      throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
    const locale = readString(asBody(raw), 'locale');
    if (!isLocale(locale))
      throw backofficeError('INVALID_INPUT', 'Unsupported locale');
    await preferencesRepository.upsertLocale(employee.employeeId, locale);
    setLocaleCookie(response, locale);
    await tryRecordAuditEvent({
      eventName: 'employee_locale_changed',
      actorEmployeeId: employee.employeeId,
      targetEmployeeId: employee.employeeId,
      action: 'SET_LOCALE',
      newValue: locale,
      result: 'SUCCESS',
      ipAddress: clientIp(request),
    });
    return { locale };
  }
}

/**
 * 配置了服务间密钥（AUTH_TOKEN）就必须提供它；没有密钥时只在本地开发开放网页初始化，
 * 部署环境（NODE_ENV=production）须用 AUTH_TOKEN 或 BOOTSTRAP_ADMIN_* 创建首个管理员。
 */
function setupNeedsServiceKey(): boolean {
  return Boolean(process.env.AUTH_TOKEN?.trim()) || isDeployed();
}

function setupKeyAccepted(provided: string): boolean {
  const expected = process.env.AUTH_TOKEN?.trim() ?? '';
  if (expected !== '') return sameSecret(provided, expected);
  return !isDeployed();
}

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
