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

import type { FaqCandidateService } from '../modules/helpdesk/flywheel/faqCandidateService';
import type { FlywheelMetrics } from '../modules/helpdesk/flywheel/flywheelMetrics';
import type { FlywheelRunsService } from '../modules/helpdesk/flywheel/flywheelRunsService';
import { runHelpdesk as run, signedInEmployee } from './helpdesk-http';
import type { BackofficeRequest } from './request-context';

export const HELPDESK_FAQ_CANDIDATE_SERVICE = Symbol(
  'HELPDESK_FAQ_CANDIDATE_SERVICE',
);
export const HELPDESK_FLYWHEEL_RUNS_SERVICE = Symbol(
  'HELPDESK_FLYWHEEL_RUNS_SERVICE',
);
export const HELPDESK_FLYWHEEL_METRICS = Symbol('HELPDESK_FLYWHEEL_METRICS');

/**
 * 数据飞轮员工端（v5 Part G3、G4、G6；界面待视觉验收）。守卫与 FAQ 一样：菜单 helpDesk，
 * GET = VIEW，写 = FULL（route-access.ts 的 /api/helpdesk/**）；执行人一律是当前登录员工。
 * 决定（接受、驳回、合并）带 version，可带 Idempotency-Key：同一个决定重试 → 200 原样返回。
 * 「立即运行」必须带 Idempotency-Key：201 新开了一次（后台跑，轮询运行行）；200 同一个 key 的那一次。
 */
@Controller('helpdesk')
export class BackofficeHelpdeskFlywheelController {
  constructor(
    @Inject(HELPDESK_FAQ_CANDIDATE_SERVICE)
    private readonly candidates: FaqCandidateService,
    @Inject(HELPDESK_FLYWHEEL_RUNS_SERVICE)
    private readonly runs: FlywheelRunsService,
    @Inject(HELPDESK_FLYWHEEL_METRICS)
    private readonly metrics: FlywheelMetrics,
  ) {}

  // ---------------------------------------------------------------- 候选

  @Get('faq-candidates')
  list(@Query() query: Record<string, unknown>) {
    return run(() => this.candidates.list(query));
  }

  @Get('faq-candidates/:candidateId')
  get(@Param('candidateId') candidateId: string) {
    return run(() => this.candidates.get(candidateId));
  }

  /** 审核数据：建议与理由、AI 当时怎么处理的、相似卡、建议的位置（只读，不调模型）。 */
  @Get('faq-candidates/:candidateId/review')
  review(@Param('candidateId') candidateId: string) {
    return run(() => this.candidates.review(candidateId));
  }

  /** 结构树（流程树与规则表），审核页选位置用。 */
  @Get('faq-map')
  faqMap() {
    return run(() => this.candidates.faqMap());
  }

  /** 新 FAQ / 追问的预填（答案留空；草稿只来自已解决工单里人写的回复，标「草稿 待核实」）。 */
  @Get('faq-candidates/:candidateId/draft')
  draft(@Param('candidateId') candidateId: string) {
    return run(() => this.candidates.draft(candidateId));
  }

  @Post('faq-candidates/:candidateId/accept')
  @HttpCode(200)
  accept(
    @Req() request: BackofficeRequest,
    @Param('candidateId') candidateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.candidates.accept(employee, candidateId, body, idempotencyKey),
    );
  }

  @Post('faq-candidates/:candidateId/dismiss')
  @HttpCode(200)
  dismiss(
    @Req() request: BackofficeRequest,
    @Param('candidateId') candidateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.candidates.dismiss(employee, candidateId, body, idempotencyKey),
    );
  }

  @Post('faq-candidates/:candidateId/merge')
  @HttpCode(200)
  merge(
    @Req() request: BackofficeRequest,
    @Param('candidateId') candidateId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() =>
      this.candidates.merge(employee, candidateId, body, idempotencyKey),
    );
  }

  /** 「转成 FAQ 候选」：201 新建；200 这张工单已经转过（那一个）。 */
  @Post('tickets/:ticketId/faq-candidate')
  async fromTicket(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('ticketId') ticketId: string,
  ) {
    const employee = signedInEmployee(request);
    const result = await run(() =>
      this.candidates.fromTicket(employee, ticketId),
    );
    response.status(result.created ? 201 : 200);
    return result;
  }

  /** 回归用例（按节点 key）；jsonl 与 CI 的 eval/helpdesk/regression-cases.jsonl 同一个形状。 */
  @Get('faq-eval-cases')
  async evalCases() {
    const jsonl = await run(() => this.candidates.evalCasesJsonl());
    return { jsonl, count: jsonl === '' ? 0 : jsonl.split('\n').length };
  }

  // ---------------------------------------------------------------- 运行

  @Get('flywheel/jobs/:job/runs')
  jobRuns(@Param('job') job: string) {
    return run(() => this.runs.list(job));
  }

  @Get('flywheel/jobs/:job/runs/:runId')
  jobRun(@Param('job') job: string, @Param('runId') runId: string) {
    return run(() => this.runs.get(job, runId));
  }

  @Post('flywheel/jobs/:job/run')
  async runNow(
    @Req() request: BackofficeRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('job') job: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    const { run: started, created } = await run(() =>
      this.runs.runNow(employee, job, idempotencyKey),
    );
    response.status(created ? 201 : 200);
    return started;
  }

  /** 工单每日数字（Portal 的只读汇总，UTC 天）：新建、解决、取消、当天结束时还开着、首次人工回复用时。 */
  @Get('flywheel/ticket-stats')
  ticketStats(@Query() query: Record<string, unknown>) {
    return run(() => this.metrics.ticketStats(query));
  }

  /** Portal 的学员原文保留任务（180 天后只留脱敏文字与标签）：运行记录。 */
  @Get('jobs/assist-retention')
  retentionRuns() {
    return run(() => this.runs.portalRetentionRuns());
  }

  @Post('jobs/assist-retention/run')
  @HttpCode(200)
  runRetention(
    @Req() request: BackofficeRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const employee = signedInEmployee(request);
    return run(() => this.runs.runPortalRetention(employee, idempotencyKey));
  }

  // ---------------------------------------------------------------- 指标

  /** ?granularity=day|week&from=&to=&split=none|locale|entry|signal */
  @Get('flywheel/metrics')
  flywheelMetrics(@Query() query: Record<string, unknown>) {
    return run(() => this.metrics.metrics(query));
  }
}
