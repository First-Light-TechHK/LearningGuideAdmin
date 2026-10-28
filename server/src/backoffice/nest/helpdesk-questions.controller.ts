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
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import type { QuestionService } from '../modules/helpdesk/questions/questionService';
import { runHelpdesk as run, signedInEmployee } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_QUESTION_SERVICE = Symbol('HELPDESK_QUESTION_SERVICE');

/**
 * Common Questions 员工端（Figma addendum §A；设计文档 §4A.7 / §5.4）。
 * 守卫：菜单 helpDesk，GET = VIEW，其余写操作 = FULL；修改人一律是当前登录员工。
 */
@Controller('helpdesk/questions')
export class BackofficeHelpdeskQuestionsController {
  constructor(
    @Inject(HELPDESK_QUESTION_SERVICE)
    private readonly questions: QuestionService,
  ) {}

  @Get()
  // 查询参数声明为 unknown：全局 ValidationPipe(transform) 会把 string 参数 String() 化
  // （?q=a&q=b → 'a,b'）；原样交给服务校验，重复或非文本一律 400 INVALID_INPUT。
  list(
    @Query('locale') locale?: unknown,
    @Query('category') category?: unknown,
    @Query('status') status?: unknown,
    @Query('q') q?: unknown,
  ) {
    return run(() => this.questions.list({ locale, category, status, q }));
  }

  @Post()
  create(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedInEmployee(request);
    return run(() => this.questions.create(employee, body));
  }

  @Post('reorder')
  @HttpCode(200)
  reorder(@Req() request: BackofficeRequest, @Body() body: unknown) {
    const employee = signedInEmployee(request);
    return run(() => this.questions.reorder(employee, body));
  }

  @Get(':questionId')
  get(@Param('questionId') questionId: string) {
    return run(() => this.questions.get(questionId));
  }

  @Get(':questionId/revisions')
  revisions(@Param('questionId') questionId: string) {
    return run(() => this.questions.revisions(questionId));
  }

  @Put(':questionId')
  update(
    @Req() request: BackofficeRequest,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.questions.update(employee, questionId, body));
  }

  @Post(':questionId/publish')
  @HttpCode(200)
  publish(
    @Req() request: BackofficeRequest,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.questions.transition(employee, questionId, 'publish', body),
    );
  }

  @Post(':questionId/unpublish')
  @HttpCode(200)
  unpublish(
    @Req() request: BackofficeRequest,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.questions.transition(employee, questionId, 'unpublish', body),
    );
  }

  @Post(':questionId/archive')
  @HttpCode(200)
  archive(
    @Req() request: BackofficeRequest,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.questions.transition(employee, questionId, 'archive', body),
    );
  }
}

/**
 * Portal 读已发布问题（Figma addendum §A / §E）：GET /api/integration/helpdesk/questions。
 * 鉴权只认 Bearer ADMIN_HELPDESK_TOKEN（守卫的 helpdeskIntegration 类）；成功体是纯 JSON
 * （不套信封），错误是 RFC 9457 problem+json；支持 ETag / If-None-Match（304）。
 */
@Controller('integration/helpdesk')
@UseFilters(ProblemJsonFilter)
export class HelpdeskIntegrationQuestionsController {
  constructor(
    @Inject(HELPDESK_QUESTION_SERVICE)
    private readonly questions: QuestionService,
  ) {}

  @Get('questions')
  async published(
    @Res() response: Response,
    @Query('locale') locale?: unknown,
    @Query('featured') featured?: unknown,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    let result: Awaited<ReturnType<QuestionService['published']>>;
    try {
      result = await this.questions.published(
        { locale, featured },
        ifNoneMatch,
      );
    } catch (error) {
      if (error instanceof HelpdeskError && error.status === 400)
        throw problem(400, 'invalid_request', error.message);
      throw error;
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
}
