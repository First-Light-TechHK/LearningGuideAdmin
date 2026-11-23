import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';

import { NotificationsError } from '../modules/notification/portalNotificationsClient';
import type { NotificationsService } from '../modules/notification/notificationsService';
import { signedInEmployee as signedIn } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const NOTIFICATIONS_SERVICE = Symbol('NOTIFICATIONS_SERVICE');

/** NotificationsError → HttpException { code, message, ...details }（全局过滤器输出统一信封）。 */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NotificationsError) {
      throw new HttpException(
        {
          code: error.code,
          message: error.message,
          ...(error.details ?? {}),
        },
        error.status,
      );
    }
    throw error;
  }
}

/**
 * Settings › Notification Configuration（PRD §6–§8、设计 §5）。
 *
 * 所有接口都是 Admin-only + Settings FULL（route-access 的 settingsAdmin）；
 * 写操作在这里由服务层注入操作人并记 BackOffice 审计。
 */
@Controller('backoffice/notifications')
export class BackofficeNotificationsController {
  constructor(
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notifications: NotificationsService,
  ) {}

  @Get('templates')
  templates() {
    return run(() => this.notifications.templates());
  }

  @Put('templates/:id')
  updateTemplate(
    @Req() request: BackofficeRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const employee = signedIn(request);
    return run(() => this.notifications.updateTemplate(employee, id, body));
  }

  @Post('templates/:id/test')
  @HttpCode(200)
  testTemplate(
    @Req() request: BackofficeRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const employee = signedIn(request);
    return run(() => this.notifications.testTemplate(employee, id, body));
  }

  @Get('audiences')
  audiences() {
    return run(() => this.notifications.audiences());
  }

  @Get('broadcasts')
  broadcasts(@Query('page') page?: unknown) {
    return run(() => this.notifications.listBroadcasts(page));
  }

  @Post('broadcasts')
  @HttpCode(200)
  createBroadcast(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedIn(request);
    return run(() => this.notifications.createBroadcast(employee, body));
  }

  @Get('broadcasts/:id')
  broadcast(@Param('id') id: string) {
    return run(() => this.notifications.broadcastDetail(id));
  }

  @Patch('broadcasts/:id')
  @HttpCode(200)
  patchBroadcast(
    @Req() request: BackofficeRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const employee = signedIn(request);
    return run(() => this.notifications.patchBroadcast(employee, id, body));
  }

  @Get('send-log')
  sendLog(@Query() query: Record<string, unknown>) {
    return run(() => this.notifications.sendLog(query));
  }

  @Get('send-log/:id')
  sendLogDetail(@Param('id') id: string) {
    return run(() => this.notifications.sendLogDetail(id));
  }
}
