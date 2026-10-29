import { HttpException } from '@nestjs/common';

/**
 * RFC 9457 problem details，服务间接口（/api/integration/**）用；员工端仍用统一信封。
 * type 与 Portal 一致：https://www.ilovelearningguide.com/problems/<code>。
 */
export const PROBLEM_TYPE_BASE = 'https://www.ilovelearningguide.com/problems/';

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'invalid_request',
  429: 'rate_limited',
  503: 'service_unavailable',
};

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** 业务代码抛出：throw problem(404, 'not_found', '…')。 */
export function problem(
  status: number,
  code: string,
  detail: string,
): HttpException {
  return new HttpException({ code, message: detail }, status);
}

export function problemBody(
  status: number,
  rawCode: string | undefined,
  detail: string,
): ProblemBody {
  const fallback =
    CODE_FOR_STATUS[status] ??
    (status >= 500 ? 'internal_error' : 'invalid_request');
  const code = rawCode && CODE.test(rawCode) ? rawCode : fallback;
  return {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Client Error'),
    status,
    detail,
    code,
  };
}
