import type { EvaluationExecution } from './evaluation-execution';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import {
  AiChatLogger,
  type AiChatLogEntry,
  type AiChatStatus,
} from './ai-chat-logger';
import { AiConfigService } from './ai-config.service';
import { ChatHistoryItemDto, ChatStreamDto } from './dto/chat-stream.dto';
import { DialogueTestStreamDto } from './dto/dialogue-test-stream.dto';
import { LearnerChatStreamDto } from './dto/learner-chat-stream.dto';
import { OpenRouterHttpError } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { compileMotherbaseDialogue } from './tutor/motherbase-dialogue';
import { buildTutorContext, loadTutorRelease } from './tutor/course-context';
import {
  RateLimitService,
  type AiRateLimitChannel,
} from './rate-limit.service';

/** 学员端语言指令（已删除，2026-10-29）：
 * - main.md 第 5 节 LANGUAGE 已正式覆盖（含 language switch 不放松 1-4 节约束）
 * - LOCALE_INSTRUCTION 硬编码冗余，不再追加
 */

const MAX_CONTEXT_MESSAGES = 20;

/**
 * AI 对话编排（§4.4.2）：限流 → 加载配置 → 聚合知识库上下文 →
 * 组装 Prompt → Provider 流式调用。
 * 对话不落库（§4.3.2 拍板）；每次对话结束后由 AiChatLogger 旁路写运行日志
 * （§4.4.2 第 7 步，2026-10-22 拍板）。
 */
@Injectable()
export class AiChatYongService {
  constructor(
    // 课程与 Release 快照归 KS 所有，只经契约读取（docs/Engine_Split_Implementation.md）
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    private readonly configs: AiConfigService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimit: RateLimitService,
    private readonly chatLogger: AiChatLogger,
  ) {}

  /** 后台测试对话：读「测试所选 Release」（aiTestReleaseId ?? currentReleaseId） */
  async *streamChat(
    dto: ChatStreamDto,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: null,
      channel: 'admin',
      quota: 'admin-test',
      signal,
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        const releaseId = course.aiTestReleaseId ?? course.currentReleaseId;
        if (dto.expectedReleaseId && dto.expectedReleaseId !== releaseId) {
          throw new ConflictException('测试版本已变化，请刷新后重试');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          // §4.3.1/§5.2（2026-10-20）：后台测试对话读「测试所选 Release」
          releaseId,
        };
      },
    });
  }

  /** 路线参数只作用于本次后台试跑，不写回课程配置或发布指针。 */
  async *streamDialogueTest(
    dto: DialogueTestStreamDto,
    signal?: AbortSignal,
    evaluation?: EvaluationExecution,
  ): AsyncGenerator<string> {
    if (!this.configs.availableModels().includes(dto.model)) {
      throw new BadRequestException('模型不在可用列表中');
    }
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: evaluation?.locale ?? dto.locale ?? null,
      channel: 'admin',
      quota: evaluation?.batch ? 'batch-test' : 'admin-test',
      signal,
      evaluation,
      testRoute: { model: dto.model, useKnowledge: dto.useKnowledge },
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        return {
          courseId: course.id,
          courseTitle: course.title,
          releaseId: dto.releaseId,
        };
      },
    });
  }

  /**
   * 学员端对话（2026-10-22）：按 Portal course.slug 匹配 Course.externalId，
   * 强制 aiTutorOnline，且只读 currentReleaseId（绝不读 aiTestReleaseId）。
   */
  async *streamLearnerChat(
    dto: LearnerChatStreamDto,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.externalCourseId,
      message: dto.message,
      mode: dto.channel === 'study-group' ? 'LECTURE' : dto.mode,
      history: dto.history,
      locale: dto.locale,
      channel: 'learner',
      quota: dto.channel ?? 'portal',
      userId: dto.userId,
      signal,
      resolve: async () => {
        const course = await this.knowledge.getCourseByExternalId(
          dto.externalCourseId,
        );
        if (!course) throw new NotFoundException('课程不存在');
        if (!course.aiTutorOnline) {
          throw new ForbiddenException('该课程 AI 导师未开放');
        }
        if (!course.currentReleaseId) {
          throw new ConflictException('该课程尚未发布可用版本');
        }
        if (
          dto.expectedReleaseId &&
          dto.expectedReleaseId !== course.currentReleaseId
        ) {
          throw new ConflictException('上线版本已变化，请刷新后重试');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          releaseId: course.currentReleaseId,
        };
      },
    });
  }

  /** 产出文本增量流；失败由控制器转 SSE 错误帧。 */
  private async *run(input: {
    /** 课程解析失败时用于日志的兜底 id（后台为 UUID，学员为 externalId） */
    courseIdHint: string;
    message: string;
    mode: 'LECTURE' | 'SOCRATIC';
    history?: ChatHistoryItemDto[];
    locale: 'en-GB' | 'zh-CN' | null;
    channel: 'admin' | 'learner';
    /** 限流分桶（2026-10-23）：直播间与后台测试各自单独配额，默认按学员个人对话计 */
    quota?: AiRateLimitChannel;
    /** Portal 学员 userId（2026-10-28）：用于日志审计和用户级限流分桶；后台测试/直播间不传 */
    userId?: string;
    signal?: AbortSignal;
    evaluation?: EvaluationExecution;
    testRoute?: { model: string; useKnowledge: boolean };
    resolve: () => Promise<{
      courseId: string;
      courseTitle: string;
      releaseId: string | null;
    }>;
  }): AsyncGenerator<string> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const history = (input.history ?? [])
      .filter(
        (item) =>
          (item.role === 'user' || item.role === 'assistant') &&
          item.content?.trim(),
      )
      .slice(-MAX_CONTEXT_MESSAGES);
    let courseId = input.courseIdHint;
    let releaseId: string | null = null;
    let providerName = 'unknown';
    let model = 'unknown';
    let answer = '';
    let promptHash: string | undefined;
    let finished = false;
    let status: AiChatStatus = 'ok';
    let errorText: string | undefined;
    let finishReason: string | null | undefined;
    let usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
        }
      | undefined;
    const attempts: NonNullable<AiChatLogEntry['attempts']> = [];
    const progress = (stage: string, attempt?: number) => {
      void this.chatLogger
        .writeProgress({
          requestId,
          stage,
          elapsedMs: Date.now() - startedAt,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.quota ?? 'portal',
          ...(attempt === undefined ? {} : { attempt }),
        })
        .catch(() => undefined);
    };

    try {
      progress('started');
      const resolved = await input.resolve();
      courseId = resolved.courseId;
      releaseId = resolved.releaseId;
      // 2026-10-29：没有可用版本（aiTestReleaseId 和 currentReleaseId 都 null）时直接拒绝，
      // 避免用空知识上下文回答（QA：新建课程未发布版本也能打开对话）
      if (!releaseId) {
        throw new BadRequestException('该课程没有可用的测试或上线版本');
      }
      await this.rateLimit.assertAllowed(
        courseId,
        input.quota ?? 'portal',
        input.userId,
      );
      progress('release_resolved');
      const release = await loadTutorRelease(
        this.knowledge,
        courseId,
        releaseId,
      );
      const buildContext = async (query: string, topics: string[] = []) => {
        if (input.testRoute?.useKnowledge === false) return '';
        const context = await buildTutorContext(
          this.knowledge,
          release,
          query,
          topics,
          'wiki',
        );
        progress(`context_${context.strategy}`);
        return context.text;
      };

      const question = input.message.trim();
      const [runConfig, context] = await Promise.all([
        this.configs
          .resolveTutorRun(courseId, releaseId, input.mode)
          .then((current) =>
            input.evaluation
              ? {
                  ...input.evaluation.snapshot,
                  runtime: {
                    ...input.evaluation.snapshot.runtime,
                    apiKey: current.runtime.apiKey,
                  },
                }
              : current,
          ),
        buildContext(question),
      ]);
      const { runtime, dialoguePrompts } = runConfig;
      if (context === null) progress('retrieval_context_empty');
      providerName = runtime.provider;
      model = input.testRoute?.model ?? runtime.model;
      progress('context_ready');
      const compiled = compileMotherbaseDialogue({
        model,
        basePrompt: dialoguePrompts.basePrompt,
        modePrompt: dialoguePrompts.modePrompt,
        knowledgeMarkdown:
          input.channel === 'learner'
            ? (context ?? '').replaceAll(
                `/api/files/images/${courseId}/`,
                `/api/user/courses/${encodeURIComponent(input.courseIdHint)}/images/`,
              )
            : (context ?? ''),
        mode: input.mode,
        message: input.message,
        history,
      });
      const messages = compiled.messages;
      promptHash = createHash('sha256')
        .update(JSON.stringify(messages))
        .digest('hex');
      const provider = this.registry.get(runtime.provider);
      const maxOutputTokens = compiled.maxOutputTokens;
      const attemptStartedAt = Date.now();
      progress('provider_start', 1);
      try {
        const gen = provider.stream({
          model,
          messages,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          temperature: compiled.temperature,
          maxOutputTokens,
          reasoningEffort: compiled.reasoningEffort,
          reasoningEnabled: compiled.reasoningEnabled,
          signal: input.signal,
          connectionTimeoutMs: 30_000,
          firstTokenTimeoutMs: 20_000,
          idleTimeoutMs: 15_000,
          onEvent: (event) => {
            if (event.type === 'finish') finishReason = event.reason;
            else usage = event.usage;
          },
        });
        for await (const delta of gen) {
          input.signal?.throwIfAborted();
          if (!delta) continue;
          if (!answer) progress('first_delta', 1);
          answer += delta;
          yield delta;
        }
        if (finishReason === 'length') {
          throw new ConflictException('AI 回答达到输出上限，内容未完成');
        }
        if (!answer.trim()) {
          throw new ConflictException(
            'AI 服务返回空回答，请重试或检查模型配置',
          );
        }
        finished = true;
      } finally {
        attempts.push({
          attempt: 1,
          finishReason,
          usage,
          answerChars: answer.length,
          latencyMs: Date.now() - attemptStartedAt,
          maxOutputTokens,
        });
      }
    } catch (err) {
      if (input.signal?.aborted) {
        status = 'aborted';
      } else {
        status = 'error';
        errorText =
          err instanceof OpenRouterHttpError && err.diagnostic
            ? `${err.message} (${err.diagnostic})`
            : err instanceof Error
              ? err.message
              : String(err);
      }
      throw err;
    } finally {
      // 未正常结束且未报错 → 客户端断开（生成器被提前 return）
      if (!finished && status === 'ok') status = 'aborted';
      progress(status);
      // 旁路写日志（§4.4.2 第 7 步）：不 await，不影响对话主流程
      void this.chatLogger
        .write({
          requestId,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.channel,
          ...(input.userId ? { userId: input.userId } : {}),
          provider: providerName,
          model,
          historyCount: history.length,
          latencyMs: Date.now() - startedAt,
          status,
          promptHash,
          error: errorText,
          finishReason,
          usage,
          attempts,
          question: input.message,
          answer,
        })
        .catch(() => {
          /* AiChatLogger 内部已兜底；此处防未来替换实现后 unhandled rejection */
        });
    }
  }
}
