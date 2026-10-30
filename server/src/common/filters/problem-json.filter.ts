import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { problemBody, type ProblemBody } from '../problem';

/** 异常 → problem+json 的状态、正文与 401 的 WWW-Authenticate；顺带按状态记日志。流式回包（SSE）也用它。 */
export function problemFor(
  exception: unknown,
  logger: Logger,
): { status: number; body: ProblemBody; wwwAuthenticate?: string } {
  let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let code: string | undefined;
  let detail = 'The server could not complete the request.';
  let wwwAuthenticate: string | undefined;

  if (exception instanceof HttpException) {
    status = exception.getStatus();
    const body = exception.getResponse();
    if (body && typeof body === 'object') {
      const raw = body as { code?: unknown; message?: unknown };
      if (typeof raw.code === 'string') code = raw.code.toLowerCase();
      if (typeof raw.message === 'string' && raw.message) detail = raw.message;
      else if (Array.isArray(raw.message)) detail = raw.message.join('; ');
    } else if (typeof body === 'string' && body) {
      detail = body;
    }
    if (status === 401)
      wwwAuthenticate =
        code === 'invalid_token'
          ? 'Bearer realm="helpdesk", error="invalid_token"'
          : 'Bearer realm="helpdesk"';
  }

  const message = `Integration request failed [${status}] ${
    exception instanceof Error ? exception.message : String(exception)
  }`;
  if (status >= 500) {
    logger.error(
      message,
      exception instanceof Error ? exception.stack : undefined,
    );
    // 5xx 不回显内部信息（503 integration_disabled 的说明是我们自己写的，保留）
    if (!(exception instanceof HttpException))
      detail = 'The server could not complete the request.';
  } else {
    logger.warn(message);
  }
  return {
    status,
    body: problemBody(status, code, detail),
    ...(wwwAuthenticate ? { wwwAuthenticate } : {}),
  };
}

/**
 * 服务间接口的错误输出（RFC 9457 application/problem+json）。
 * 挂在 /api/integration/helpdesk/** 的控制器上（@UseFilters），全局守卫抛出的 401 / 503
 * 也经由它输出。响应体只含稳定码与可读说明，绝不带堆栈或 SQL。
 */
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemJsonFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, wwwAuthenticate } = problemFor(
      exception,
      this.logger,
    );
    if (wwwAuthenticate)
      response.setHeader('WWW-Authenticate', wwwAuthenticate);
    response
      .status(status)
      .type('application/problem+json')
      .send(JSON.stringify(body));
  }
}
