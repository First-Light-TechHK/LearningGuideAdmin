import { randomUUID } from 'node:crypto';
import { AiChatService } from './ai-chat.service';
import { pipeSseWithAbort } from './sse-stream';
import { ChatStreamDto } from './dto/chat-stream.dto';
import type { EvaluationSnapshot } from './evaluation-execution';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Request } from 'express';
type BackofficeRequest = Request & { employee?: { employeeId: string } };
import { EvaluationService } from './evaluation.service';
import type { EvaluationConfig } from './evaluation.service';
import type { EvaluationQuestion } from './evaluation-contract';
import { validateQuestions } from './evaluation-contract';
import {
  evaluationExample,
  parseEvaluationExample,
  workbook,
} from './evaluation-excel';

@Controller('ai/evaluation')
export class EvaluationController {
  private readonly sessions = new Map<
    string,
    {
      owner: string;
      config: EvaluationConfig;
      snapshot: EvaluationSnapshot;
      expires: number;
      busy: boolean;
    }
  >();
  constructor(
    private readonly tasks: EvaluationService,
    private readonly chat: AiChatService,
  ) {}
  @Post('sessions')
  async session(
    @Req() req: BackofficeRequest,
    @Body() config: EvaluationConfig,
  ) {
    const owner = this.owner(req);
    for (const [id, session] of this.sessions)
      if (session.expires < Date.now() && !session.busy)
        this.sessions.delete(id);
    if (
      !config ||
      !Array.isArray(config.modes) ||
      config.modes.length !== 1 ||
      !['LECTURE', 'SOCRATIC'].includes(config.modes[0]) ||
      !['grounded-jack', 'dialogue-yong'].includes(config.runningSolution) ||
      (config.locale !== undefined &&
        !['zh-CN', 'en-GB'].includes(config.locale))
    )
      throw new BadRequestException('INVALID_CONFIG');
    if (this.sessions.size >= 500)
      throw new BadRequestException('SESSION_LIMIT');
    const snapshots = await this.tasks.snapshot(config);
    const id = randomUUID();
    this.sessions.set(id, {
      owner,
      config,
      snapshot: snapshots[config.modes[0]]!,
      expires: Date.now() + 30 * 60 * 1000,
      busy: false,
    });
    return { id };
  }
  @Post('sessions/:id/answer')
  async answer(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
    @Body() dto: ChatStreamDto,
    @Res() res: Response,
  ) {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.owner !== this.owner(req) ||
      session.expires < Date.now()
    )
      throw new BadRequestException('SESSION_EXPIRED_START_NEW_TEST');
    if (session.busy) throw new BadRequestException('SESSION_BUSY');
    session.busy = true;
    try {
      await pipeSseWithAbort(
        (signal) =>
          this.chat.streamDialogueTest(
            {
              ...session.config,
              useKnowledge: true,
              mode: session.config.modes[0],
              message: dto.message,
              history: dto.history,
            },
            signal,
            {
              snapshot: session.snapshot,
              locale: session.config.locale,
              batch: false,
            },
          ),
        res,
      );
    } finally {
      session.busy = false;
      session.expires = Date.now() + 30 * 60 * 1000;
    }
  }
  private owner(req: BackofficeRequest) {
    if (!req.employee) throw new BadRequestException('EMPLOYEE_REQUIRED');
    return req.employee.employeeId;
  }
  @Get('tasks') list(@Req() req: BackofficeRequest) {
    return this.tasks.list(this.owner(req));
  }
  @Get('template') downloadTemplate(
    @Query('mode') mode: string,
    @Res() res: Response,
  ) {
    if (mode !== 'LECTURE' && mode !== 'SOCRATIC')
      throw new BadRequestException('INVALID_TEMPLATE');
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment(`ai-test-${mode}.xlsx`)
      .send(evaluationExample(mode));
  }
  @Post('validate')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  validate(
    @UploadedFile() file: Express.Multer.File,
    @Body('config') raw: string,
  ) {
    if (!file || !file.originalname.toLowerCase().endsWith('.xlsx'))
      throw new BadRequestException('INVALID_XLSX');
    let config: EvaluationConfig;
    try {
      config = JSON.parse(raw) as EvaluationConfig;
    } catch {
      throw new BadRequestException('INVALID_CONFIG');
    }
    if (!config || !Array.isArray(config.modes))
      throw new BadRequestException('INVALID_CONFIG');
    const { questions, mode: exampleMode } = parseEvaluationExample(
      file.buffer,
    );
    if (config.modes.length !== 1)
      throw new BadRequestException('INVALID_MODES');
    config = { ...config, kind: 'multi' };
    return {
      questions,
      mode: config.modes[0],
      exampleMode,
      errors: validateQuestions(questions, config.modes, config.kind),
      total: questions.length * config.modes.length,
    };
  }
  @Post('tasks') create(
    @Req() req: BackofficeRequest,
    @Body()
    body: {
      config: EvaluationConfig;
      questions: EvaluationQuestion[];
      source?: string;
      submissionKey?: string;
    },
  ) {
    const source = body.source ? Buffer.from(body.source, 'base64') : undefined;
    if (source && source.length > 5 * 1024 * 1024)
      throw new BadRequestException('FILE_TOO_LARGE');
    if (source) {
      const parsedFile = parseEvaluationExample(source);
      if (body.config.modes.length !== 1 || body.config.kind !== 'multi')
        throw new BadRequestException('INVALID_MODES');
      const parsed = parsedFile.questions;
      if (JSON.stringify(parsed) !== JSON.stringify(body.questions))
        throw new BadRequestException('FILE_CONTENT_CHANGED');
    }
    return this.tasks.create(
      this.owner(req),
      body.config,
      body.questions,
      source,
      undefined,
      body.submissionKey,
    );
  }
  @Get('tasks/:id') get(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
  ) {
    return this.tasks.get(this.owner(req), id);
  }
  @Post('tasks/:id/stop') stop(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
  ) {
    return this.tasks.stop(this.owner(req), id);
  }
  @Post('tasks/:id/restart') restart(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
  ) {
    return this.tasks.restart(this.owner(req), id);
  }
  @Delete('tasks/:id') remove(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
  ) {
    return this.tasks.remove(this.owner(req), id);
  }
  @Delete('tasks/:id/source') removeSource(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
  ) {
    return this.tasks.remove(this.owner(req), id, true);
  }
  @Get('tasks/:id/export')
  async export(
    @Req() req: BackofficeRequest,
    @Param('id') id: string,
    @Query('format') format: string,
    @Query('locale') locale: string,
    @Res() res: Response,
  ) {
    const task = await this.tasks.get(this.owner(req), id);
    if (format === 'json') {
      res.attachment(`${id}.json`).json(task);
      return;
    }
    const en = locale === 'en-GB';
    const headers = en
      ? [
          'Conversation ID',
          'Turn',
          'Question',
          'Mode',
          'Answer',
          'Status',
          'Error',
          'Latency ms',
          'Notes',
        ]
      : [
          '会话编号',
          '轮次',
          '问题',
          '模式',
          '回答',
          '状态',
          '错误',
          '耗时毫秒',
          '备注',
        ];
    const rows = task.results.map((r) => [
      r.conversationId,
      r.turn,
      r.question,
      r.mode,
      r.answer,
      en
        ? r.status
        : {
            pending: '待执行',
            running: '生成中',
            success: '成功',
            failed: '失败',
          }[r.status],
      r.error ?? '',
      r.latencyMs,
      r.notes,
    ]);
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment(`${id}.xlsx`)
      .send(
        workbook([
          [
            en ? 'Overview' : '测试概览',
            [
              ['ID', id],
              ['Status', task.status],
              ...Object.entries(task.config).map(([key, value]) => [
                key,
                String(value),
              ]),
              ['Created', task.createdAt],
            ],
          ],
          [en ? 'Results' : '测试结果', [headers, ...rows]],
          [
            en ? 'Errors' : '错误记录',
            [headers, ...rows.filter((r) => Boolean(r[6]))],
          ],
        ]),
      );
  }
}
