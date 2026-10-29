import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  ATTACHMENT_INLINE_TYPES,
  type AttachmentCharset,
} from '../modules/helpdesk/contracts';
import type { HelpdeskService } from '../modules/helpdesk/helpdeskService';
import {
  runHelpdesk as run,
  signedInEmployee as signedIn,
} from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_SERVICE = Symbol('HELPDESK_SERVICE');

function isInlineAttachment(contentType: string): boolean {
  return (ATTACHMENT_INLINE_TYPES as readonly string[]).includes(contentType);
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * txt / csv 可能是 UTF-8、UTF-16 或 GBK 等旧编码：转发 Portal 标的 charset（只认 UTF-8 / UTF-16），
 * 旧编码不标 charset（总是下载），绝不自己补 utf-8，免得按头解码的查看器乱码。
 */
export function attachmentContentType(
  contentType: string,
  charset: AttachmentCharset | null,
): string {
  return contentType.startsWith('text/') && charset
    ? `${contentType}; charset=${charset}`
    : contentType;
}

/** 图片 inline；其它 attachment，带 ASCII 兜底名与 RFC 5987 filename*。 */
export function contentDisposition(
  contentType: string,
  fileName: string | null,
  attachmentId: string,
): string {
  if (isInlineAttachment(contentType)) return 'inline';
  const name =
    fileName ??
    `attachment-${attachmentId}.${EXTENSIONS[contentType] ?? 'bin'}`;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
  // 查询参数声明为 unknown：全局 ValidationPipe(transform) 会把 string 参数 String() 化
  // （?q=a&q=b → 'a,b'）；原样交给服务校验，重复或非文本一律 400 INVALID_INPUT。
  list(
    @Query('status') status?: unknown,
    @Query('category') category?: unknown,
    @Query('tag') tag?: unknown,
    @Query('q') q?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
    @Query('flagged') flagged?: unknown,
    @Query('learnerId') learnerId?: unknown,
  ) {
    return run(() =>
      this.helpdesk.list({
        status,
        category,
        tag,
        q,
        cursor,
        limit,
        flagged,
        learnerId,
      }),
    );
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

  /**
   * 附件经本服务代理（浏览器不直连 Portal）。图片内联显示，其余（pdf / txt / csv / docx / xlsx）
   * 一律作为下载；类型白名单见 contracts.ts，绝不放行 html / svg。
   */
  @Get('attachments/:attachmentId')
  async attachment(
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await run(() => this.helpdesk.attachment(attachmentId));
    response.setHeader(
      'Content-Type',
      attachmentContentType(file.contentType, file.charset),
    );
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader(
      'Content-Disposition',
      contentDisposition(file.contentType, file.fileName, attachmentId),
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.status(200).end(file.data);
  }
}
