import { HttpException } from '@nestjs/common';

import type { SessionEmployee } from '../contracts/employee';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import { backofficeError } from './errors';
import type { BackofficeRequest } from './request-context';

/** HelpdeskError → HttpException { code, message }（员工端由全局过滤器输出统一信封）。 */
export async function runHelpdesk<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HelpdeskError) {
      throw new HttpException(
        { code: error.code, message: error.message },
        error.status,
      );
    }
    throw error;
  }
}

/** BackofficeAccessGuard 已按菜单 helpDesk 校验：GET = VIEW，写 = FULL。 */
export function signedInEmployee(request: BackofficeRequest): SessionEmployee {
  const employee = request.employee;
  if (!employee)
    throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
  return employee;
}
