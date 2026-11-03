import {
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Param,
  Query,
} from '@nestjs/common';

import {
  HELPDESK_TRACE_SOURCE,
  type HelpdeskTraceSource,
} from '../../contracts/helpdesk-trace';
import { backofficeError } from './errors';

const SEQ = /^[1-9][0-9]{0,8}$/;
const HOURS = /^[1-9][0-9]{0,2}$/;
/** 与 Agent 的 MODEL_HEALTH.hoursMax 一致（一周）。 */
const HOURS_MAX = 168;

/**
 * 「查看链路」（helpdesk-agent-v2-pi-dsh §2，dsh sessionQuery）：只读。
 * - GET /api/helpdesk/agent-runs/:runId → { runId, parentRunId, chain, events }
 * - GET /api/helpdesk/agent-runs/:runId/events/:seq → { event, sources, derived }
 * - GET /api/helpdesk/agent-runs/health?hours=24 → 每一步的模型输出健康（ModelHealthReport，缺省 24 小时）
 * 守卫：菜单 helpDesk 的 GET = VIEW（六个角色都有）。日志归 Agent，这里只经契约
 * HelpdeskTraceSource 读导出副本（学员原文已脱敏），不 import Agent 的实现。
 */
@Controller('helpdesk/agent-runs')
export class BackofficeHelpdeskAgentRunsController {
  constructor(
    @Inject(HELPDESK_TRACE_SOURCE)
    private readonly traces: HelpdeskTraceSource,
  ) {}

  // 写在 :runId 前面：路由按声明顺序匹配
  @Get('health')
  @Header('Cache-Control', 'no-store')
  async health(@Query('hours') raw?: string) {
    const hours = raw === undefined || raw === '' ? 24 : Number(raw);
    if (
      (raw !== undefined && raw !== '' && !HOURS.test(raw)) ||
      hours > HOURS_MAX
    )
      throw backofficeError(
        'INVALID_INPUT',
        `hours must be an integer from 1 to ${HOURS_MAX}`,
      );
    return this.traces.modelHealth(hours);
  }

  @Get(':runId')
  @Header('Cache-Control', 'no-store')
  async run(@Param('runId') runId: string) {
    const run = await this.traces.readRun(runId);
    if (!run) throw notFound('AGENT_RUN_NOT_FOUND', 'No such agent run');
    return run;
  }

  @Get(':runId/events/:seq')
  @Header('Cache-Control', 'no-store')
  async event(@Param('runId') runId: string, @Param('seq') seq: string) {
    if (!SEQ.test(seq))
      throw backofficeError('INVALID_INPUT', 'seq must be a positive integer');
    const detail = await this.traces.traceEvent(runId, Number(seq));
    if (!detail)
      throw notFound('AGENT_EVENT_NOT_FOUND', 'No such agent run event');
    return detail;
  }
}

function notFound(code: string, message: string): HttpException {
  return new HttpException({ code, message }, 404);
}
