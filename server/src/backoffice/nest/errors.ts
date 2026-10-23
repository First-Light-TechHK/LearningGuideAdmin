import { HttpException } from '@nestjs/common';

import { ERROR_STATUS, type ErrorCode } from '../contracts/envelope';

/** 抛出带稳定错误码的异常，由全局过滤器输出 { success:false, error:{ code, message } }。 */
export function backofficeError(
  code: ErrorCode,
  message: string,
): HttpException {
  return new HttpException({ code, message }, ERROR_STATUS[code]);
}
