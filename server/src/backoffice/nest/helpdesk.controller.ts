import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import type { HelpdeskService } from '../modules/helpdesk/helpdeskService';
import { backofficeError } from './errors';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_SERVICE = Symbol('HELPDESK_SERVICE');

/** HelpdeskError → 统一信封 { success:false, error:{ code, message } }。 */
async function run<T>(work: () => Promise<T>): Promise<T> {
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

function signedIn(request: BackofficeRequest) {
  // BackofficeAccessGuard 已按菜单 helpDesk 校验：GET = VIEW，写 = FULL
  const employee = request.employee;
  if (!employee)
    throw backofficeError('INVALID_EMPLOYEE_ACCOUNT', 'Sign in required');
  return employee;
}

/**
 * HelpDesk 工单（设计文档 §4A / §5.4）。数据归 Portal，这里只经集成接口转发，
 * 写操作注入当前登录员工为 agent。
 */
@Controller('helpdesk')
export class BackofficeHelpdeskController {
  constructor(
    @Inject(HELPDESK_SERVICE) private readonly helpdesk: HelpdeskService,
  ) {}

  @Get('tickets')
  list(
    @Query('tab') tab?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return run(() => this.helpdesk.list({ tab, q, cursor, limit }));
  }

  @Get('tickets/:ticketId')
  detail(@Param('ticketId') ticketId: string) {
    return run(() => this.helpdesk.detail(ticketId));
  }

  @Post('tickets/:ticketId/messages')
  @HttpCode(200)
  reply(
    @Req() request: BackofficeRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedIn(request);
    return run(() =>
      this.helpdesk.reply(employee, ticketId, body, idempotencyKey),
    );
  }

  @Post('tickets/:ticketId/actions')
  @HttpCode(200)
  act(
    @Req() request: BackofficeRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedIn(request);
    return run(() =>
      this.helpdesk.act(employee, ticketId, body, idempotencyKey),
    );
  }

  /** 附件图片经本服务代理（浏览器不直连 Portal）；只放行 png / jpeg / webp。 */
  @Get('attachments/:attachmentId')
  async attachment(
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await run(() => this.helpdesk.attachment(attachmentId));
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.status(200).end(file.data);
  }
}
