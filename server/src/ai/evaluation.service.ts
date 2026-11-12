import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import { loadTutorRelease } from './tutor/course-context';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
export interface EvaluationDatabase {
  pool: () => Pool;
  query: <T extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<T[]>;
}
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import {
  createResults,
  EvaluationKind,
  EvaluationLocale,
  EvaluationMode,
  EvaluationQuestion,
  EvaluationResult,
  stopResults,
  validateQuestions,
} from './evaluation-contract';
import { EvaluationSnapshot } from './evaluation-execution';

export interface EvaluationConfig {
  courseId: string;
  releaseId: string;
  model: string;
  runningSolution: 'grounded-jack' | 'dialogue-yong';
  locale?: EvaluationLocale;
  modes: EvaluationMode[];
  kind: EvaluationKind;
}
export interface EvaluationTask {
  id: string;
  owner: string;
  status: 'queued' | 'running' | 'stopping' | 'stopped' | 'completed';
  config: EvaluationConfig;
  questions: EvaluationQuestion[];
  results: EvaluationResult[];
  snapshots: Partial<Record<EvaluationMode, EvaluationSnapshot>>;
  createdAt: string;
}
type Row = {
  id: string;
  owner: string;
  status: EvaluationTask['status'];
  payload: Omit<EvaluationTask, 'id' | 'owner' | 'status'>;
};
const unpack = (row: Row): EvaluationTask => ({
  ...row.payload,
  id: row.id,
  owner: row.owner,
  status: row.status,
});

@Injectable()
export class EvaluationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private active?: AbortController;
  private readonly logger = new Logger(EvaluationService.name);
  constructor(
    @Inject('EVALUATION_DB') private readonly db: EvaluationDatabase,
    private readonly chat: AiChatService,
    private readonly configs: AiConfigService,
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
  ) {}

  onModuleInit() {
    this.schedule();
  }
  onModuleDestroy() {
    this.closed = true;
    clearTimeout(this.timer);
    this.active?.abort();
  }
  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((e: unknown) =>
          this.logger.error(
            e instanceof Error ? e.message : 'Evaluation worker failed',
          ),
        )
        .finally(() => this.schedule());
    }, 2000);
    this.timer.unref();
  }
  async list(owner: string) {
    const rows = await this.db.query<Row>(
      `SELECT id,owner,status,(payload - 'snapshots' - 'questions' - 'results') || '{"results":[]}'::jsonb AS payload FROM ai_evaluation_tasks WHERE owner=$1 ORDER BY created_at DESC LIMIT 50`,
      [owner],
    );
    return rows.map(unpack);
  }
  async get(owner: string, id: string) {
    const rows = await this.db.query<Row>(
      'SELECT id,owner,status,payload FROM ai_evaluation_tasks WHERE owner=$1 AND id=$2',
      [owner, id],
    );
    if (!rows[0]) throw new NotFoundException('TASK_NOT_FOUND');
    return unpack(rows[0]);
  }
  async create(
    owner: string,
    config: EvaluationConfig,
    questions: EvaluationQuestion[],
    source?: Buffer,
    restart?: EvaluationTask,
    submissionKey: string = randomUUID(),
  ) {
    if (
      !config ||
      !['grounded-jack', 'dialogue-yong'].includes(config.runningSolution) ||
      (config.locale !== undefined &&
        !['zh-CN', 'en-GB'].includes(config.locale)) ||
      !Array.isArray(config.modes) ||
      !Array.isArray(questions)
    )
      throw new BadRequestException('INVALID_CONFIG');
    if (!restart && config.modes.length !== 1)
      throw new BadRequestException('INVALID_MODES');
    const errors = validateQuestions(questions, config.modes, config.kind);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    await loadTutorRelease(this.knowledge, config.courseId, config.releaseId);
    if (!this.configs.availableModels().includes(config.model))
      throw new BadRequestException('MODEL_UNAVAILABLE');
    const snapshots = restart?.snapshots ?? (await this.snapshot(config));
    const task: EvaluationTask = {
      id: randomUUID(),
      owner,
      status: 'queued',
      config,
      questions,
      snapshots,
      results: createResults(questions, config.modes),
      createdAt: new Date().toISOString(),
    };
    const { id, status, owner: taskOwner, ...payload } = task;
    const inserted = await this.db.query<{ id: string }>(
      'INSERT INTO ai_evaluation_tasks(id,owner,status,payload,source,submission_key) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(owner,submission_key) DO NOTHING RETURNING id',
      [
        id,
        taskOwner,
        status,
        JSON.stringify(payload),
        source ?? null,
        submissionKey,
      ],
    );
    if (!inserted.length) {
      const existing = await this.db.query<{ id: string }>(
        'SELECT id FROM ai_evaluation_tasks WHERE owner=$1 AND submission_key=$2',
        [owner, submissionKey],
      );
      return this.get(owner, existing[0].id);
    }
    return task;
  }
  async snapshot(config: EvaluationConfig) {
    await loadTutorRelease(this.knowledge, config.courseId, config.releaseId);
    if (!this.configs.availableModels().includes(config.model))
      throw new BadRequestException('MODEL_UNAVAILABLE');
    const snapshots: EvaluationTask['snapshots'] = {};
    for (const mode of config.modes) {
      const run = await this.configs.resolveTutorRun(
        config.courseId,
        config.releaseId,
        mode,
      );
      const { apiKey: omitted, ...runtime } = run.runtime;
      void omitted;
      snapshots[mode] = {
        ...run,
        runtime: { ...runtime, model: config.model },
        prompts: {
          ...run.prompts,
          systemPrompt: run.prompts.systemPrompt,
        },
        dialoguePrompts: {
          ...run.dialoguePrompts,
          modePrompt: run.dialoguePrompts.modePrompt,
        },
      };
    }
    return snapshots;
  }
  async stop(owner: string, id: string) {
    await this.get(owner, id);
    await this.db.query(
      "UPDATE ai_evaluation_tasks SET status=CASE WHEN status='queued' THEN 'stopped' ELSE 'stopping' END WHERE id=$1 AND owner=$2 AND status IN ('queued','running')",
      [id, owner],
    );
    const task = await this.get(owner, id);
    if (task.status === 'stopped') {
      task.results = stopResults(task.results);
      await this.save(task, 'stopped');
    }
    return task;
  }
  async restart(owner: string, id: string) {
    const task = await this.get(owner, id);
    if (task.status !== 'stopped' && task.status !== 'completed')
      throw new ConflictException('TASK_STILL_RUNNING');
    return this.create(owner, task.config, task.questions, undefined, task);
  }
  async remove(owner: string, id: string, sourceOnly = false) {
    const task = await this.get(owner, id);
    if (sourceOnly) {
      await this.db.query(
        'UPDATE ai_evaluation_tasks SET source=NULL WHERE id=$1 AND owner=$2',
        [id, owner],
      );
      return;
    }
    if (['running', 'stopping', 'queued'].includes(task.status))
      throw new ConflictException('STOP_TASK_FIRST');
    await this.db.query(
      'DELETE FROM ai_evaluation_tasks WHERE id=$1 AND owner=$2',
      [id, owner],
    );
  }
  private async save(task: EvaluationTask, expected: EvaluationTask['status']) {
    const { id, owner, status, ...payload } = task;
    const rows = await this.db.query(
      'UPDATE ai_evaluation_tasks SET payload=$1::jsonb,status=$2 WHERE id=$3 AND owner=$4 AND status=$5 RETURNING id',
      [JSON.stringify(payload), status, id, owner, expected],
    );
    return rows.length > 0;
  }
  private async tick() {
    const connection = await this.db.pool().connect();
    let locked = false;
    let disconnected = false;
    const lost = () => {
      disconnected = true;
      this.active?.abort();
    };
    connection.on('error', lost);
    try {
      const lock = await connection.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(731002001) AS locked',
      );
      locked = lock.rows[0].locked;
      if (!locked) return;
      await this.db.query(
        "DELETE FROM ai_evaluation_tasks WHERE created_at < now()-interval '30 days' AND status NOT IN ('running','stopping')",
      );
      const rows = await this.db.query<Row>(
        "SELECT id,owner,status,payload FROM ai_evaluation_tasks WHERE status IN ('queued','running','stopping') ORDER BY created_at LIMIT 1",
      );
      if (!rows[0]) return;
      const task = unpack(rows[0]);
      const expected = task.status;
      if (expected === 'stopping') {
        task.results = stopResults(task.results);
        task.status = 'stopped';
        await this.save(task, expected);
        return;
      }
      if (expected === 'running') {
        task.results = task.results.map((r) =>
          r.status === 'running'
            ? { ...r, status: 'failed', error: 'EXECUTION_INTERRUPTED' }
            : r,
        );
      }
      task.status = 'running';
      if (!(await this.save(task, expected))) return;
      let lastDispatch = 0;
      for (const result of task.results) {
        const waitMs = 3100 - (Date.now() - lastDispatch);
        if (waitMs > 0)
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (this.closed || disconnected) return;
        if ((await this.get(task.owner, task.id)).status !== 'running') break;
        if (result.status !== 'pending') continue;
        const previous = task.results.filter(
          (r) =>
            r.mode === result.mode &&
            r.conversationId === result.conversationId &&
            r.turn < result.turn,
        );
        if (previous.some((r) => r.status !== 'success')) {
          result.status = 'failed';
          result.error = 'PREVIOUS_TURN_FAILED';
          await this.save(task, 'running');
          continue;
        }
        result.status = 'running';
        if (!(await this.save(task, 'running'))) break;
        lastDispatch = Date.now();
        const controller = new AbortController();
        this.active = controller;
        const started = Date.now();
        let polling = false;
        const watcher = setInterval(() => {
          if (polling) return;
          polling = true;
          void this.get(task.owner, task.id)
            .then((current) => {
              if (current.status !== 'running') controller.abort();
            })
            .catch(() => controller.abort())
            .finally(() => {
              polling = false;
            });
        }, 500);
        try {
          for await (const delta of this.chat.streamDialogueTest(
            {
              ...task.config,
              useKnowledge: true,
              mode: result.mode,
              message: result.question,
              history: previous.flatMap((r) => [
                { role: 'user' as const, content: r.question },
                { role: 'assistant' as const, content: r.answer },
              ]),
            },
            controller.signal,
            {
              batch: true,
              locale: task.config.locale,
              snapshot: task.snapshots[result.mode]!,
            },
          )) {
            result.answer += delta;
          }
          if (controller.signal.aborted)
            throw new Error('EXECUTION_INTERRUPTED');
          if (!result.answer.trim()) throw new Error('EMPTY_ANSWER');
          result.status = 'success';
        } catch (error) {
          result.status = 'failed';
          result.error =
            error instanceof Error ? error.message : 'GENERATION_FAILED';
        } finally {
          clearInterval(watcher);
          this.active = undefined;
          result.latencyMs = Date.now() - started;
        }
        const current = await this.get(task.owner, task.id);
        if (current.status === 'stopping') {
          result.status = 'running';
          task.results = stopResults(task.results);
          task.status = 'stopped';
          await this.save(task, 'stopping');
          return;
        }
        if (!(await this.save(task, 'running'))) {
          if ((await this.get(task.owner, task.id)).status === 'stopping') {
            result.status = 'running';
            task.results = stopResults(task.results);
            task.status = 'stopped';
            await this.save(task, 'stopping');
          }
          return;
        }
      }
      const current = await this.get(task.owner, task.id);
      task.status = current.status === 'stopping' ? 'stopped' : 'completed';
      if (task.status === 'stopped') task.results = stopResults(task.results);
      await this.save(task, current.status);
    } finally {
      try {
        if (locked && !disconnected)
          await connection.query('SELECT pg_advisory_unlock(731002001)');
      } finally {
        connection.off('error', lost);
        connection.release(disconnected);
      }
    }
  }
}
