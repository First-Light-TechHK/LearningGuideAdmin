import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  ProblemJsonFilter,
  problemFor,
} from '../../common/filters/problem-json.filter';
import { HelpdeskSuggestService } from './helpdesk-suggest.service';

/**
 * Portal → Agent 的 Helpdesk 推荐接口（Figma addendum §C / §E）：
 * - POST /api/integration/helpdesk/suggest → { suggestion: {id, qaId, question, answer} | null }
 * - POST /api/integration/helpdesk/suggestions/:id/outcome → { id, outcome, changed }
 * 请求头 traceparent（W3C Trace Context）原样交给服务：有效的接着这条 trace，无效或缺失就新开。
 * 鉴权只认 Bearer ADMIN_HELPDESK_TOKEN（全局守卫的 helpdeskIntegration 类，豁免员工登录）；
 * 成功体是纯 JSON（不套信封），错误是 RFC 9457 problem+json。
 * 请求头 Accept 含 text/event-stream 时（Portal 的「思考中」面板）改用 SSE：每开一步发
 * event: step（data {"step": 步骤名}，见 STREAM_STEPS），最后 event: result（data 就是上面的 JSON），
 * 出错则 event: error（data 是同样的 problem 正文）。守卫拦下的 401 / 503 照旧是 problem+json。
 */
@Controller('integration/helpdesk')
@UseFilters(ProblemJsonFilter)
export class HelpdeskSuggestController {
  private readonly logger = new Logger(HelpdeskSuggestController.name);

  constructor(private readonly suggestions: HelpdeskSuggestService) {}

  @Post('suggest')
  @HttpCode(200)
  async suggest(
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    // Portal 等不及（4 秒）断开连接时中止本次 run（turn/end aborted），不再等模型
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    if (!/\btext\/event-stream\b/.test(request.get('accept') ?? '')) {
      const result = await this.suggestions.suggest(body, {
        traceparent: request.get('traceparent'),
        signal: controller.signal,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
      return;
    }
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    // Portal 已断开时不再写（run 也已经中止）
    const send = (event: string, data: unknown) => {
      if (!response.destroyed)
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await this.suggestions.suggest(body, {
        traceparent: request.get('traceparent'),
        signal: controller.signal,
        onStep: (step) => send('step', { step }),
      });
      send('result', result);
    } catch (error) {
      send('error', problemFor(error, this.logger).body);
    }
    response.end();
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
