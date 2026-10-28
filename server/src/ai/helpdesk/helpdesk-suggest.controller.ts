import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';

import { ProblemJsonFilter } from '../../common/filters/problem-json.filter';
import { HelpdeskSuggestService } from './helpdesk-suggest.service';

/**
 * Portal → Agent 的 Helpdesk 推荐接口（Figma addendum §C / §E）：
 * - POST /api/integration/helpdesk/suggest → { suggestion: {id, qaId, question, answer} | null }
 * - POST /api/integration/helpdesk/suggestions/:id/outcome → { id, outcome, changed }
 * 鉴权只认 Bearer ADMIN_HELPDESK_TOKEN（全局守卫的 helpdeskIntegration 类，豁免员工登录）；
 * 成功体是纯 JSON（不套信封），错误是 RFC 9457 problem+json。
 */
@Controller('integration/helpdesk')
@UseFilters(ProblemJsonFilter)
export class HelpdeskSuggestController {
  constructor(private readonly suggestions: HelpdeskSuggestService) {}

  @Post('suggest')
  @HttpCode(200)
  async suggest(@Body() body: unknown, @Res() response: Response) {
    const result = await this.suggestions.suggest(body);
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json(result);
  }

  @Post('suggestions/:suggestionId/outcome')
  @HttpCode(200)
  async outcome(
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const result = await this.suggestions.recordOutcome(suggestionId, body);
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json(result);
  }
}
