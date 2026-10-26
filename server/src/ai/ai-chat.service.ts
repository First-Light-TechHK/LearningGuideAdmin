import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiChatLogger, type AiChatStatus } from './ai-chat-logger';
import { AiConfigService } from './ai-config.service';
import { EmbeddingService } from './embedding/embedding.service';
import { ChatHistoryItemDto, ChatStreamDto } from './dto/chat-stream.dto';
import { LearnerChatStreamDto } from './dto/learner-chat-stream.dto';
import { LlmMessage } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';
import { RateLimitService } from './rate-limit.service';

/** 学员端语言指令（2026-10-22；默认模板已包含教学风格，不再追加固定苏格拉底指令） */
// The language instruction follows the student's own message, not the portal
// locale: a zh-CN ask from an en-GB profile must still be answered in Chinese.
// It never forces a language other than the one the question was written in.
const LOCALE_INSTRUCTION: Record<'en-GB' | 'zh-CN', string> = {
  'en-GB':
    "Answer in the language of the student's latest message. Use British English when that message is in English, and never switch language on your own.",
  'zh-CN':
    '请使用提问者最新一条消息所用的语言回答；如果该消息是中文，请使用简体中文，不要自行切换语言。',
};

/** 多轮上下文最多携带的历史条数（防 token 膨胀） */
const MAX_HISTORY = 10;

/** RAG 检索参数（2026-10-26 新增，对齐系统设计 §9.4） */
const RETRIEVAL_TOP_K = 6;
const RETRIEVAL_SCORE_THRESHOLD = 0.35;
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
    private readonly prisma: PrismaService,
    private readonly configs: AiConfigService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimit: RateLimitService,
    private readonly chatLogger: AiChatLogger,
    private readonly embedding: EmbeddingService,
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
      resolve: async () => {
        const course = await this.prisma.course.findUnique({
          where: { id: dto.courseId },
          select: {
            id: true,
            currentReleaseId: true,
            aiTestReleaseId: true,
          },
        });
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
      resolve: async () => {
        const course = await this.prisma.course.findFirst({
          where: { externalId: dto.externalCourseId },
          select: {
            id: true,
            currentReleaseId: true,
            aiTutorOnline: true,
          },
        });
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
    /** 限流分桶（2026-10-23）：直播间单独配额，默认按学员个人对话计 */
    quota?: 'portal' | 'study-group';
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
      this.rateLimit.assertAllowed(courseId, input.quota ?? 'portal');

      const [runtime, prompts, context] = await Promise.all([
        this.configs.resolveRuntime(courseId, releaseId, input.mode),
        this.configs.resolvePrompts(courseId, releaseId, input.mode),
        this.buildContext(releaseId, input.message),
      ]);
      providerName = runtime.provider;
      model = runtime.model;

      const systemParts = [prompts.systemPrompt];
      if (input.locale) systemParts.push(LOCALE_INSTRUCTION[input.locale]);
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
        ...history,
        { role: 'user', content: input.message },
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
   * RAG 检索上下文（2026-10-26 改造，替代原全文塞入方案）：
   * 1. 对用户问题生成 embedding
   * 2. 在 Release 的 KnowledgeChunk 中做余弦相似度检索（topK=6，阈值=0.35）
   * 3. 按 token 预算（8k）拼接检索结果，带 [Source: ...] 引用标记
   *
   * 若检索 0 结果或该 Release 未建索引，返回空上下文（模型回退到通用解释）。
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

    // 生成 query embedding
    const queryVec = await this.embedding.embedQuery(query);
    const vecStr = `[${queryVec.join(',')}]`;

    // 向量检索（余弦相似度）
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        pageTitle: string;
        heading: string | null;
        content: string;
        score: number;
        tokenCount: number;
      }>
    >(
      `
      SELECT "pageTitle", "heading", "content",
             1 - (embedding <=> $1::vector(1536)) AS score,
             "tokenCount"
      FROM "KnowledgeChunk"
      WHERE "releaseId" = $2
      ORDER BY embedding <=> $1::vector(1536)
      LIMIT $3
    `,
      vecStr,
      releaseId,
      RETRIEVAL_TOP_K,
    );

    // 过滤低于阈值的结果
    const relevant = rows.filter((r) => r.score >= RETRIEVAL_SCORE_THRESHOLD);

    if (relevant.length === 0) {
      return '';
    }

    // 按 token 预算拼接，超出时按 score 从高到低截断
    const blocks: string[] = [];
    let totalTokens = 0;
    for (const r of relevant) {
      if (totalTokens + r.tokenCount > CONTEXT_TOKEN_BUDGET) break;
      const source = r.heading ? `${r.pageTitle} - ${r.heading}` : r.pageTitle;
      blocks.push(`[Source: ${source}]\n${r.content}`);
      totalTokens += r.tokenCount;
    }

    return blocks.join('\n\n');
  }
}
