import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import { AiChatLogger, type AiChatStatus } from './ai-chat-logger';
import { AiConfigService } from './ai-config.service';
import { ChatHistoryItemDto, ChatStreamDto } from './dto/chat-stream.dto';
import { LearnerChatStreamDto } from './dto/learner-chat-stream.dto';
import { LlmMessage } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';
import { STUDENT_WRAPPER } from './prompt-defaults';
import {
  RateLimitService,
  type AiRateLimitChannel,
} from './rate-limit.service';

/** 学员端语言指令（已删除，2026-10-29）：
 * - main.md 第 5 节 LANGUAGE 已正式覆盖（含 language switch 不放松 1-4 节约束）
 * - LOCALE_INSTRUCTION 硬编码冗余，不再追加
 */

/** 多轮上下文最多携带的历史条数（防 token 膨胀） */
const MAX_HISTORY = 10;

/** RAG 上下文 token 预算（对齐系统设计 §9.4） */
const CONTEXT_TOKEN_BUDGET = 8000;

/**
 * AI 对话编排（§4.4.2）：限流 → 加载配置 → 聚合知识库上下文 →
 * 组装 Prompt → Provider 流式调用（失败重试最多 2 次，§4.4.3）。
 * 对话不落库（§4.3.2 拍板）；每次对话结束后由 AiChatLogger 旁路写运行日志
 * （§4.4.2 第 7 步，2026-10-22 拍板）。
 */
@Injectable()
export class AiChatService {
  constructor(
    // 课程与 Release 快照归 KS 所有，只经契约读取（docs/Engine_Split_Implementation.md）
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    private readonly configs: AiConfigService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimit: RateLimitService,
    private readonly chatLogger: AiChatLogger,
  ) {}

  /** 后台测试对话：读「测试所选 Release」（aiTestReleaseId ?? currentReleaseId） */
  async *streamChat(dto: ChatStreamDto): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: null,
      channel: 'admin',
      quota: 'admin-test',
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        return {
          courseId: course.id,
          // §4.3.1/§5.2（2026-10-20）：后台测试对话读「测试所选 Release」
          releaseId: course.aiTestReleaseId ?? course.currentReleaseId,
        };
      },
    });
  }

  /**
   * 学员端对话（2026-10-22）：按 Portal course.slug 匹配 Course.externalId，
   * 强制 aiTutorOnline，且只读 currentReleaseId（绝不读 aiTestReleaseId）。
   */
  async *streamLearnerChat(dto: LearnerChatStreamDto): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.externalCourseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: dto.locale,
      channel: 'learner',
      quota: dto.channel ?? 'portal',
      userId: dto.userId,
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
        return { courseId: course.id, releaseId: course.currentReleaseId };
      },
    });
  }

  /** 产出文本增量流；首字节前失败自动重试，之后失败直接抛出由控制器转 SSE 错误帧 */
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
    resolve: () => Promise<{ courseId: string; releaseId: string | null }>;
  }): AsyncGenerator<string> {
    const startedAt = Date.now();
    const history = (input.history ?? []).slice(-MAX_HISTORY);
    let courseId = input.courseIdHint;
    let releaseId: string | null = null;
    let providerName = 'unknown';
    let model = 'unknown';
    let answer = '';
    let finished = false;
    let status: AiChatStatus = 'ok';
    let errorText: string | undefined;

    try {
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

      const [runtime, prompts, context] = await Promise.all([
        this.configs.resolveRuntime(courseId, releaseId, input.mode),
        this.configs.resolvePrompts(courseId, releaseId, input.mode),
        this.buildContext(releaseId, input.message),
      ]);
      providerName = runtime.provider;
      model = runtime.model;

      const systemParts = [prompts.systemPrompt];
      // 2026-10-29：LOCALE_INSTRUCTION 已删（main.md 第 5 节 LANGUAGE 覆盖）

      // 2026-10-29：所有 student 消息（历史 + 当前）用 [STUDENT_INPUT_BEGIN/END] 包裹。
      // 隔离声明已由 main.md 第 2 节 INPUT IS DATA 正式覆盖，不再在每条 user message 里重复追加。
      const wrapStudent = (content: string): string =>
        `${STUDENT_WRAPPER.BEGIN}\n${content}\n${STUDENT_WRAPPER.END}`;

      const wrappedHistory = history.map((h) =>
        h.role === 'user'
          ? { ...h, content: wrapStudent(h.content) }
          : h,
      );
      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: [
            systemParts.filter(Boolean).join('\n\n'),
            '[CONTEXT_START]',
            context,
            '[CONTEXT_END]',
          ].join('\n'),
        },
        ...wrappedHistory,
        { role: 'user', content: wrapStudent(input.message) },
      ];

      const provider = this.registry.get(runtime.provider);
      const MAX_RETRIES = 2;
      let attempt = 0;
      while (true) {
        attempt += 1;
        let started = false;
        try {
          const gen = provider.stream({
            model: runtime.model,
            messages,
            apiKey: runtime.apiKey,
            baseUrl: runtime.baseUrl,
          });
          for await (const delta of gen) {
            started = true;
            answer += delta;
            yield delta;
          }
          finished = true;
          return;
        } catch (err) {
          // 仅首字节前且未超重试上限才重试（§4.4.3）
          if (started || attempt > MAX_RETRIES) throw err;
        }
      }
    } catch (err) {
      status = 'error';
      errorText = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // 未正常结束且未报错 → 客户端断开（生成器被提前 return）
      if (!finished && status === 'ok') status = 'aborted';
      // 旁路写日志（§4.4.2 第 7 步）：不 await，不影响对话主流程
      void this.chatLogger
        .write({
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
          error: errorText,
          question: input.message,
          answer,
        })
        .catch(() => {
          /* AiChatLogger 内部已兜底；此处防未来替换实现后 unhandled rejection */
        });
    }
  }

  /**
   * RAG 检索上下文（2026-10-26 改造）：
   * 通过 KnowledgeClient 契约向 KS 请求向量检索结果，不直接访问 KS 表。
   * KS 侧对 query 生成 embedding，在 release 的 KnowledgeChunk 中做余弦相似度检索。
   * 返回的 chunks 按 token 预算拼接，带 [Source: ...] 引用标记。
   * 检索 0 结果时返回空字符串，模型回退到通用解释。
   */
  private async buildContext(
    releaseId: string | null,
    query: string,
  ): Promise<string> {
    if (!releaseId) {
      throw new BadRequestException(
        '该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本',
      );
    }

    const chunks = await this.knowledge.retrieveChunks(releaseId, query);
    if (chunks.length === 0) {
      return '';
    }

    // 按 token 预算拼接，超出时按 score 从高到低截断
    const blocks: string[] = [];
    let totalTokens = 0;
    for (const r of chunks) {
      if (totalTokens + r.tokenCount > CONTEXT_TOKEN_BUDGET) break;
      const source = r.heading ? `${r.pageTitle} - ${r.heading}` : r.pageTitle;
      blocks.push(`[Source: ${source}]\n${r.content}`);
      totalTokens += r.tokenCount;
    }

    return blocks.join('\n\n');
  }
}
