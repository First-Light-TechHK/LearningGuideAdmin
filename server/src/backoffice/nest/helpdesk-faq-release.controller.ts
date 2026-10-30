import {
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';

import { ProblemJsonFilter } from '../../common/filters/problem-json.filter';
import { problem } from '../../common/problem';
import {
  currentRelease,
  HELPDESK_FAQ_RELEASE_SOURCE,
  type CurrentReleaseResult,
  type FaqReleaseSource,
} from '../modules/helpdesk/faqs/faqRelease';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * Portal 读 FAQ 问题树的已发布快照（helpdesk-v5-faq-graph-design §4「Caching」，契约 fixture v6）：
 * - GET /api/integration/helpdesk/faq-release/current?locale=en-GB|zh-CN
 *   → 200 FaqRelease { version, publishedAt, locale, nodes, edges }，ETag "v<version>"、Cache-Control no-cache；
 *   If-None-Match 命中 → 304（无体）；还没有发布版本 → 404 problem+json code no_release；
 *   locale 不对 → 400 invalid_request。
 * 鉴权与其它集成接口一样只认 Bearer ADMIN_HELPDESK_TOKEN（守卫的 helpdeskIntegration 类，路径在
 * /api/integration/helpdesk/** 下）。Portal 内存缓存、每 60 秒带 If-None-Match 校验，Admin 出错时继续用上一版。
 */
@Controller('integration/helpdesk')
@UseFilters(ProblemJsonFilter)
export class HelpdeskIntegrationFaqReleaseController {
  constructor(
    @Inject(HELPDESK_FAQ_RELEASE_SOURCE)
    private readonly releases: FaqReleaseSource,
  ) {}

  @Get('faq-release/current')
  async current(
    @Res() response: Response,
    @Query('locale') locale?: unknown,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    let result: CurrentReleaseResult;
    try {
      result = await currentRelease(this.releases, locale, ifNoneMatch);
    } catch (error) {
      if (error instanceof HelpdeskError && error.status === 400)
        throw problem(400, 'invalid_request', error.message);
      throw error;
    }
    response.setHeader('Cache-Control', 'no-cache');
    if (result.kind === 'none')
      throw problem(404, 'no_release', 'No FAQ release has been published yet');
    response.setHeader('ETag', result.etag);
    if (result.notModified) {
      response.status(304).end();
      return;
    }
    response.status(200).json(result.body);
  }
}
