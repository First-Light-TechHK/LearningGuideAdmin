import { Logger, type OnModuleDestroy } from '@nestjs/common';

import { problem } from '../../common/problem';
import { isUuid, uuidv7 } from '../../common/uuidv7';
import {
  faqCategoryFor,
  isHelpdeskLocale,
  type FaqCategory,
  type HelpdeskQaCandidate,
  type HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import type { TurnEndReason } from '../../contracts/helpdesk-trace';
import type { RateLimitStore } from '../rate-limit.service';
import {
  isSuggestionOutcome,
  SUGGESTION_SOURCES,
  type HelpdeskSuggestionLog,
  type SuggestionOutcome,
  type SuggestionSource,
} from './helpdesk-suggestion.store';
import type { AgentEventLog } from './trace/agent-event.store';
import { RunTrace } from './trace/run-trace';
import {
  childTraceparent,
  startTrace,
  type TraceContext,
} from './trace/traceparent';
import {
  runWorkflow,
  type AgentStepRunner,
  type WorkflowTemplate,
} from './workflow/engine';
import {
  chipWorkflow,
  faqWorkflow,
  initialFaqState,
} from './workflow/faq-workflow';

/**
 * Helpdesk 推荐答案（Figma addendum §C；Tickets v2 §2；helpdesk-agent-v2-pi-dsh，Agent 角色）。
 *
 * 来源 source：submit（提交工单弹窗）、chat（聊天面板提问）、chip（聊天面板点常见问题）。
 * - chip 带 faqId：chip 工作流直接返回该已发布 FAQ，不调模型、不要 API key，但照样记一行；
 * - chat / submit 走 FAQ 工作流（workflow/faq-workflow.ts，步骤由代码定）：
 * 1. 每学员每小时 submit 最多 10 次、chat + chip 合计最多 30 次（共用 ai_rate_limit_hits，
 *    两个独立的键），超出返回 null；
 * 2. retrieve：从已发布 FAQ 里取候选（全文 + 关键词 + 同类加权，前 8 个），没有候选不调模型；
 * 3. pick_faq：一个 pi Agent 步（pi-agent-core 原样），唯一的工具 pick_faq 的 faqId 只能是候选 id
 *    或 none；模型写在代码里（DEFAULT_MODEL），HELPDESK_SUGGEST_MODEL 只在要换模型时才设，
 *    key / 模型 / base URL 每次现读；3 秒 AbortSignal、不重试，且整次推荐不超过 3.5 秒
 *    （Portal 等 4 秒），过期的答案不返回、不记 faq_id；没有 API key、任何错误都返回 null
 *    （绝不阻塞学员提交工单）；
 * 4. validate → answer：再核一遍是候选之一，返回库里的原答案，模型从不写给学员看的文字；
 * 5. 每次检索写一行 helpdesk_suggestions；query_text 90 天后清空（本实例每小时最多清一次）；
 * 6. 链路：每次推荐一个 run（id = Portal 给的 runId，否则新的 uuidv7；答中时也是 suggestion id），
 *    事件按 dsh SessionEvent 写进 helpdesk_agent_events；W3C traceparent 的 trace id 记在
 *    turn/start，发往 OpenRouter 的是它的子 span；学员反馈追加一条 feedback。
 */

export const SUGGEST_TIMEOUT_MS = 3_000;
/**
 * 整次推荐（限流 + 检索 + 模型）的总期限，低于 Portal 的 ADMIN_SUGGEST_TIMEOUT_MS（4 秒）：
 * 过了期限 Portal 已放弃、直接建单，学员没看到答案，所以不再记 qa_id（不计入 shown）。
 */
export const SUGGEST_DEADLINE_MS = 3_500;
export const SUGGEST_CANDIDATES = 8;
export const SUGGEST_RATE_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;
export const QUERY_TEXT_RETENTION_DAYS = 90;
/** 聊天面板（chat + chip）每学员每小时的额度，与 submit 分开计。 */
export const ASSIST_RATE_LIMIT = { limit: 30, windowMs: 3_600_000 } as const;
const PURGE_EVERY_MS = 3_600_000;
// 2026-10-29 真模型评测（qa10k dev 难例）：比 gpt-4o-mini 答错少、更快
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
// OPENROUTER_BASE_URL 是 AI Tutor 已有的变量，这里同样每次现读
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const LIMITS = {
  learnerIdMax: 128,
  subjectMax: 120,
  messageMax: 5000,
} as const;

export type Suggestion = {
  id: string;
  faqId: string;
  question: string;
  answer: string;
};

type SuggestInput = {
  learnerId: string;
  locale: string;
  source: SuggestionSource;
  /** 原样记日志的类型（工单类型或 FAQ 分类）；没有为 null。 */
  category: string | null;
  /** 同类加权用的 FAQ 分类。 */
  faqCategory: FaqCategory | null;
  subject: string;
  message: string;
  /** 仅 chip：学员点的 FAQ（小写 uuid）。 */
  faqId: string | null;
  /** Portal 预先生成的 run id（= 它的 assist 行 id）；没给则新生成。 */
  runId: string | null;
  /** 同一段对话的第一个 run（Portal 给）。 */
  parentRunId: string | null;
};

export type SuggestContext = {
  /** 收到的 W3C traceparent 头。 */
  traceparent?: string;
  /** 调用方放弃（Portal 断开）时中止。 */
  signal?: AbortSignal;
};

export type HelpdeskSuggestDeps = {
  qa: HelpdeskQaSource;
  /** agent 步的运行时（PiStepRunner）。 */
  runner: AgentStepRunner;
  rateLimit: RateLimitStore;
  log: HelpdeskSuggestionLog;
  /** dsh 事件日志（helpdesk_agent_events）。 */
  events: AgentEventLog;
  /** 每次调用现读（默认 process.env），便于轮换 key / 切模型。 */
  env?: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * 模型由代码定（DEFAULT_MODEL，评测选出的那个），部署不用配；HELPDESK_SUGGEST_MODEL 只用来临时换模型。
 * 不看 AI_AVAILABLE_MODELS：那是 AI Tutor 的列表，排第一的模型不一定适合推荐。
 */
export function suggestModel(env: NodeJS.ProcessEnv): string {
  return env.HELPDESK_SUGGEST_MODEL?.trim() || DEFAULT_MODEL;
}

function invalid(detail: string) {
  return problem(400, 'invalid_request', detail);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 控制字符（保留 \t \n \r）：query_text 是 PostgreSQL TEXT，不收 U+0000。 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function optionalUuid(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw invalid(`${key} must be a UUID`);
  return value.toLowerCase();
}

function optionalText(body: Record<string, unknown>, key: string, max: number) {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${key} must be text`);
  if (CONTROL.test(value)) throw invalid(`${key} has invalid characters`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw invalid(`${key} must be at most ${max} characters`);
  return trimmed;
}

function parseInput(raw: unknown): SuggestInput {
  const body = record(raw);
  const learnerId =
    typeof body.learnerId === 'string' ? body.learnerId.trim() : '';
  if (learnerId === '' || learnerId.length > LIMITS.learnerIdMax)
    throw invalid('learnerId is required');
  if (!isHelpdeskLocale(body.locale))
    throw invalid('locale must be en-GB or zh-CN');
  // v1 的 Portal 不带 source：按 submit
  const source = body.source ?? 'submit';
  if (!(SUGGESTION_SOURCES as readonly unknown[]).includes(source))
    throw invalid('source must be submit, chat or chip');
  let category: string | null = null;
  let faqCategory: FaqCategory | null = null;
  if (body.category !== undefined && body.category !== null) {
    faqCategory = faqCategoryFor(body.category);
    if (!faqCategory) throw invalid('Unknown category');
    category = body.category as string;
  }
  const subject = optionalText(body, 'subject', LIMITS.subjectMax);
  const message = optionalText(body, 'message', LIMITS.messageMax);
  let faqId: string | null = null;
  if (source === 'chip') {
    if (!isUuid(body.faqId)) throw invalid('faqId is required for a chip');
    faqId = body.faqId.toLowerCase();
  } else if (source === 'chat') {
    if (message === '') throw invalid('message is required');
  } else if (subject === '' && message === '') {
    throw invalid('subject or message is required');
  }
  return {
    learnerId,
    locale: body.locale,
    source: source as SuggestionSource,
    category,
    faqCategory,
    subject,
    message,
    faqId,
    runId: optionalUuid(body, 'runId'),
    parentRunId: optionalUuid(body, 'parentRunId'),
  };
}

type Decided = {
  chosen: HelpdeskQaCandidate | null;
  reason: TurnEndReason;
  model: string | null;
};

export class HelpdeskSuggestService implements OnModuleDestroy {
  readonly timeoutMs: number;
  private readonly logger = new Logger('HelpdeskSuggest');
  private lastPurge = Number.NEGATIVE_INFINITY;
  private readonly writing = new Set<Promise<void>>();

  constructor(private readonly deps: HelpdeskSuggestDeps) {
    this.timeoutMs = deps.timeoutMs ?? SUGGEST_TIMEOUT_MS;
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ? this.deps.env() : process.env;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /** 事件日志在后台写，不拖慢推荐；失败只记日志。 */
  private background(what: string, work: Promise<unknown>): void {
    const done = work.then(
      () => undefined,
      (error: unknown) => this.warn(what, error),
    );
    this.writing.add(done);
    void done.finally(() => this.writing.delete(done));
  }

  /** 等后台的事件写完（测试、评测与停机用）。 */
  async flushTraces(): Promise<void> {
    while (this.writing.size > 0) await Promise.all([...this.writing]);
  }

  /** 停机（main.ts 开了 enableShutdownHooks，SIGTERM 时 Nest 调这里）：先写完缓冲的事件。 */
  onModuleDestroy(): Promise<void> {
    return this.flushTraces();
  }

  /** 输入不合法抛 400；其余任何问题都返回 { suggestion: null }。 */
  async suggest(
    raw: unknown,
    context: SuggestContext = {},
  ): Promise<{ suggestion: Suggestion | null }> {
    const input = parseInput(raw);
    const started = this.now();
    const runId = input.runId ?? uuidv7(started);
    const trace = startTrace(context.traceparent);
    const run = new RunTrace(runId, this.deps.events, () => this.now());
    run.emit('turn/start', {
      turn: run.turn,
      workflow: input.source === 'chip' ? 'chip' : 'faq',
      source: input.source,
      locale: input.locale,
      category: input.category,
      ...(input.faqId ? { faqId: input.faqId } : {}),
      parentRunId: input.parentRunId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentId,
      input: { subject: input.subject, message: input.message },
    });
    let decided: Decided = { chosen: null, reason: 'error', model: null };
    let suggestion: Suggestion | null = null;
    try {
      decided = await this.decide(input, runId, run, trace, context.signal);
      suggestion = decided.chosen
        ? {
            id: runId,
            faqId: decided.chosen.id,
            question: decided.chosen.question,
            answer: decided.chosen.answer,
          }
        : null;
    } catch (error) {
      decided = { chosen: null, reason: 'error', model: decided.model };
      this.warn('Suggestion skipped', error);
    }
    run.emit('turn/end', {
      turn: run.turn,
      reason: decided.reason,
      faqId: suggestion?.faqId ?? null,
      model: decided.model,
      latencyMs: this.now() - started,
    });
    this.background('Agent event log write failed', run.flush());
    return { suggestion };
  }

  /** 限流 → 工作流 → 期限 → 记一行；返回结束原因。 */
  private async decide(
    input: SuggestInput,
    runId: string,
    run: RunTrace,
    trace: TraceContext,
    callerSignal: AbortSignal | undefined,
  ): Promise<Decided> {
    const env = this.env();
    const apiKey = env.OPENROUTER_API_KEY?.trim() ?? '';
    // chip 不调模型，不需要 key
    if (apiKey === '' && input.source !== 'chip')
      return { chosen: null, reason: 'no_key', model: null };
    const deadline = this.now() + SUGGEST_DEADLINE_MS;
    const left = () => deadline - this.now();
    const limit =
      input.source === 'submit' ? SUGGEST_RATE_LIMIT : ASSIST_RATE_LIMIT;
    const allowed = await this.deps.rateLimit.tryHit(
      `${input.source === 'submit' ? 'helpdesk-suggest' : 'helpdesk-assist'}:${input.learnerId}`,
      limit.limit,
      limit.windowMs,
    );
    if (!allowed) return { chosen: null, reason: 'rate_limited', model: null };
    if (left() <= 0) return { chosen: null, reason: 'timeout', model: null };

    const started = this.now();
    const steps = {
      trace: run,
      signal: callerSignal,
      stepTimeoutMs: () => Math.min(this.timeoutMs, left()),
      traceparent: () => childTraceparent(trace),
    };

    if (input.source === 'chip') {
      const faqId = input.faqId as string;
      const { state, reason } = await runWorkflow(
        chipWorkflow({ qa: this.deps.qa }),
        { faqId, locale: input.locale, chosen: null },
        steps,
      );
      return this.logAndDecide(input, runId, {
        queryText: input.message || state.chosen?.question || '',
        candidateIds: [faqId],
        chosen: state.chosen,
        reason,
        model: null,
        started,
        left,
      });
    }

    const model = suggestModel(env);
    const template: WorkflowTemplate<ReturnType<typeof initialFaqState>> =
      faqWorkflow({ qa: this.deps.qa, limit: SUGGEST_CANDIDATES, left });
    const { state, reason, trail } = await runWorkflow(
      template,
      initialFaqState({
        locale: input.locale,
        category: input.faqCategory,
        subject: input.subject,
        message: input.message,
      }),
      {
        ...steps,
        runner: this.deps.runner,
        model: {
          provider: 'openrouter',
          model,
          apiKey,
          baseUrl: env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL,
        },
      },
    );
    // 走到了 pick_faq 才算问过模型
    const asked = trail.includes('pick_faq');
    return this.logAndDecide(input, runId, {
      queryText: state.queryText,
      candidateIds: state.candidates.map((c) => c.id),
      chosen: state.chosen,
      reason,
      model: asked ? model : null,
      started,
      left,
    });
  }

  private async logAndDecide(
    input: SuggestInput,
    runId: string,
    result: {
      queryText: string;
      candidateIds: string[];
      chosen: HelpdeskQaCandidate | null;
      reason: TurnEndReason;
      model: string | null;
      started: number;
      left: () => number;
    },
  ): Promise<Decided> {
    let { chosen, reason } = result;
    // 过了期限才定下来的答案学员看不到：记一行检索，但不记 faq_id
    if (chosen && result.left() <= 0) {
      chosen = null;
      reason = 'timeout';
    }
    await this.deps.log.record({
      id: runId,
      learnerId: input.learnerId,
      locale: input.locale,
      source: input.source,
      category: input.category,
      queryText: result.queryText,
      candidateIds: result.candidateIds,
      faqId: chosen?.id ?? null,
      model: result.model,
      latencyMs: this.now() - result.started,
    });
    this.purgeLater();
    return { chosen, reason, model: result.model };
  }

  /** 没有定时任务：每个实例每小时最多顺手清一次 90 天前的学员原文（失败不影响推荐）。 */
  private purgeLater(): void {
    const now = this.now();
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    const cutOff = new Date(now - QUERY_TEXT_RETENTION_DAYS * 24 * 3_600_000);
    this.deps.log.purgeQueryText(cutOff).catch((error: unknown) => {
      this.warn('Query text purge failed', error);
    });
    this.deps.events.purgeLearnerText(cutOff).catch((error: unknown) => {
      this.warn('Agent event learner text purge failed', error);
    });
  }

  /**
   * 学员反馈：首个为准，同值重复 OK，不同值不覆盖（changed=false）。
   * submit 收 solved / declined / edited，chat / chip 收 helpful / not_helpful，别的 400。
   * 记下的那一个同时追加到 run 的事件日志（feedback）；只接在已有的 run 后面，从不单独起一个 run。
   */
  async recordOutcome(
    rawId: string,
    raw: unknown,
  ): Promise<{ id: string; outcome: SuggestionOutcome; changed: boolean }> {
    if (!isUuid(rawId)) throw invalid('Invalid suggestion id');
    const outcome = record(raw).outcome;
    if (!isSuggestionOutcome(outcome))
      throw invalid(
        'outcome must be solved, declined, edited, helpful or not_helpful',
      );
    const id = rawId.toLowerCase();
    const result = await this.deps.log.setOutcome(id, outcome);
    if (result.kind === 'not_found')
      throw problem(404, 'not_found', 'No such suggestion');
    if (result.kind === 'wrong_source')
      throw invalid(
        `outcome ${outcome} does not apply to a ${result.source} answer`,
      );
    if (result.changed)
      this.background(
        'Agent event log write failed',
        this.deps.events.append(
          id,
          [{ type: 'feedback', time: new Date(this.now()), data: { outcome } }],
          { existing: true },
        ),
      );
    return { id, outcome: result.outcome, changed: result.changed };
  }
}
