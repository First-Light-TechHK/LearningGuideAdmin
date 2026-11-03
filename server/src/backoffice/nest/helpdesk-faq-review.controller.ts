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
} from '@nestjs/common';

import type { FaqReviewService } from '../modules/helpdesk/faqs/faqReview';
import type { FaqRewriteService } from '../modules/helpdesk/faqs/faqRewrite';
import { runHelpdesk as run, signedInEmployee } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_FAQ_REVIEW_SERVICE = Symbol(
  'HELPDESK_FAQ_REVIEW_SERVICE',
);
export const HELPDESK_FAQ_REWRITE_SERVICE = Symbol(
  'HELPDESK_FAQ_REWRITE_SERVICE',
);

/**
 * FAQ 逐张审核与「AI 按指令改卡」（owner 2026-10-31；接口说明 candidate-review/api-spec.md §8–§10）。
 * 守卫：菜单 helpDesk，GET = VIEW（审核队列、改动历史），写 = FULL（审核、AI 改卡）。
 * - GET  /api/helpdesk/faq-reviews?status=unreviewed|ok|needs_change|all&category=&q=&page=&pageSize=
 * - POST /api/helpdesk/faqs/:faqId/review { status, note?, version }（Idempotency-Key 可选）
 * - GET  /api/helpdesk/faqs/:faqId/history
 * - POST /api/helpdesk/faqs/rewrite（只用 DeepSeek，不保存）
 */
@Controller('helpdesk')
export class BackofficeHelpdeskFaqReviewController {
  constructor(
    @Inject(HELPDESK_FAQ_REVIEW_SERVICE)
    private readonly reviews: FaqReviewService,
    @Inject(HELPDESK_FAQ_REWRITE_SERVICE)
    private readonly rewriter: FaqRewriteService,
  ) {}

  @Get('faq-reviews')
  // 查询参数原样交给服务校验（重复或非文本 → 400 INVALID_INPUT）
  queue(@Query() query: Record<string, unknown>) {
    return run(() => this.reviews.queue(query));
  }

  @Post('faqs/rewrite')
  @HttpCode(200)
  rewrite(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedInEmployee(request);
    return run(() => this.rewriter.rewrite(employee, body));
  }

  @Post('faqs/:faqId/review')
  @HttpCode(200)
  review(
    @Req() request: BackofficeRequest,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.reviews.review(employee, faqId, body, idempotencyKey),
    );
  }

  @Get('faqs/:faqId/history')
  history(@Param('faqId') faqId: string) {
    return run(() => this.reviews.history(faqId));
  }
}
