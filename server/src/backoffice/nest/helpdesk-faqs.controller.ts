import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';

import { ProblemJsonFilter } from '../../common/filters/problem-json.filter';
import { problem } from '../../common/problem';
import type { FaqService } from '../modules/helpdesk/faqs/faqService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import { runHelpdesk as run, signedInEmployee } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_FAQ_SERVICE = Symbol('HELPDESK_FAQ_SERVICE');

/**
 * FAQs 员工端（Tickets v2 §3，Figma 1379:2 / 1379:299）。
 * 守卫：菜单 helpDesk，GET = VIEW（列表、打开、预览、修订），其余写操作 = FULL；
 * 修改人一律是当前登录员工。删除 = POST :id/archive（幂等）。
 */
@Controller('helpdesk/faqs')
export class BackofficeHelpdeskFaqsController {
  constructor(
    @Inject(HELPDESK_FAQ_SERVICE)
    private readonly faqs: FaqService,
  ) {}

  @Get()
  // 查询参数声明为 unknown：全局 ValidationPipe(transform) 会把 string 参数 String() 化
  // （?q=a&q=b → 'a,b'）；原样交给服务校验，重复或非文本一律 400 INVALID_INPUT。
  list(
    @Query('category') category?: unknown,
    @Query('popular') popular?: unknown,
    @Query('q') q?: unknown,
    @Query('page') page?: unknown,
    @Query('pageSize') pageSize?: unknown,
  ) {
    return run(() => this.faqs.list({ category, popular, q, page, pageSize }));
  }

  @Post()
  create(
    @Req() request: BackofficeRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.faqs.create(employee, body, idempotencyKey));
  }

  @Get(':faqId')
  get(@Param('faqId') faqId: string) {
    return run(() => this.faqs.get(faqId));
  }

  @Get(':faqId/revisions')
  revisions(@Param('faqId') faqId: string) {
    return run(() => this.faqs.revisions(faqId));
  }

  @Put(':faqId')
  update(
    @Req() request: BackofficeRequest,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.faqs.update(employee, faqId, body));
  }

  @Post(':faqId/archive')
  @HttpCode(200)
  archive(
    @Req() request: BackofficeRequest,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.faqs.archive(employee, faqId, body));
  }
}

/** HelpdeskError → RFC 9457（400 invalid_request / 404 not_found）。 */
function asProblem(error: unknown): unknown {
  if (error instanceof HelpdeskError) {
    if (error.status === 400)
      return problem(400, 'invalid_request', error.message);
    if (error.status === 404) return problem(404, 'not_found', error.message);
  }
  return error;
}

/**
 * Portal 读已发布 FAQ（Tickets v2 §2）：
 * - GET /api/integration/helpdesk/faqs?locale=&popular=&category=&q=&limit= → { faqs, etag }（ETag / 304）
 * - GET /api/integration/helpdesk/faqs/:id?locale= → 一条，或 404
 * 鉴权只认 Bearer ADMIN_HELPDESK_TOKEN（守卫的 helpdeskIntegration 类）；成功体是纯 JSON
 * （不套信封），错误是 RFC 9457 problem+json。
 */
@Controller('integration/helpdesk')
@UseFilters(ProblemJsonFilter)
export class HelpdeskIntegrationFaqsController {
  constructor(
    @Inject(HELPDESK_FAQ_SERVICE)
    private readonly faqs: FaqService,
  ) {}

  @Get('faqs')
  async published(
    @Res() response: Response,
    @Query('locale') locale?: unknown,
    @Query('popular') popular?: unknown,
    @Query('category') category?: unknown,
    @Query('q') q?: unknown,
    @Query('limit') limit?: unknown,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    let result: Awaited<ReturnType<FaqService['published']>>;
    try {
      result = await this.faqs.published(
        { locale, popular, category, q, limit },
        ifNoneMatch,
      );
    } catch (error) {
      throw asProblem(error);
    }
    response.setHeader('ETag', result.etag);
    // 允许缓存但每次回源校验（Portal 侧自有 60 秒缓存）
    response.setHeader('Cache-Control', 'no-cache');
    if (result.notModified) {
      response.status(304).end();
      return;
    }
    response.status(200).json(result.body);
  }

  @Get('faqs/:faqId')
  async one(
    @Res() response: Response,
    @Param('faqId') faqId: string,
    @Query('locale') locale?: unknown,
  ): Promise<void> {
    let faq: Awaited<ReturnType<FaqService['publishedOne']>>;
    try {
      faq = await this.faqs.publishedOne(faqId, { locale });
    } catch (error) {
      throw asProblem(error);
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.status(200).json(faq);
  }
}
