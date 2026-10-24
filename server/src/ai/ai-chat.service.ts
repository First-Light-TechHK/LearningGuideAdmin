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

/** heading 文本转 slug（与 sync.service.ts / PageEditor.tsx 保持一致） */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      // 保留 Unicode 字母/数字（含中文），仅去掉标点符号等特殊字符；
      // 之前用 \w 会把中文全部清空，导致多个中文 heading 生成相同 key（h2-）而碰撞。
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
  );
}

/** 生成带层级前缀的 heading key：`h{n}-{slug}`（与 sync.service.ts 一致） */
function headingKey(level: number, text: string): string {
  return `h${level}-${slugify(text)}`;
}

/**
 * 按 H1-H6 切分 Markdown。
 * 每段记录 heading 文本、层级、以及该段原始行（含后续低层级内容，直到下一同级或更高级标题）。
 * 首段 heading 为空（前置内容）。
 */
function splitByHeadings(md: string): {
  heading: string;
  level: number;
  body: string;
}[] {
  const lines = md.split('\n');
  const sections: { heading: string; level: number; body: string[] }[] = [
    { heading: '', level: 0, body: [] },
  ];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      sections.push({ heading: m[2], level: m[1].length, body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    body: s.body.join('\n').trim(),
  }));
}

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
      await this.rateLimit.assertAllowed(courseId, input.quota ?? 'portal');

      const [runtime, prompts, context] = await Promise.all([
        this.configs.resolveRuntime(courseId, releaseId, input.mode),
        this.configs.resolvePrompts(courseId, releaseId, input.mode),
        this.buildContext(releaseId),
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
   * 知识库上下文聚合（§4.4.2 第 3 步，2026-10-15 拍板改 §4.3.3；2026-10-20 按 Release 维度）：
   * 读「测试所选 Release」（Course.aiTestReleaseId ?? currentReleaseId）指向的 Release 快照，
   * 不再读实时草稿——创建 Release 后未再次发布的编辑不影响 AI。快照本身已在发布时过滤 STALE 节点
   * （§3.4.3），此处无需再过滤。未发布过的课程直接报错交用户在 Knowledge Releases 页创建版本。
   */
  private async buildContext(releaseId: string | null): Promise<string> {
    if (!releaseId) {
      throw new BadRequestException(
        '该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本',
      );
    }
    const release = await this.knowledge.getRelease(releaseId);
    if (!release) {
      throw new BadRequestException(
        '该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本',
      );
    }
    const blocks: string[] = [];
    for (const page of release.pages) {
      const content = page.contentMd?.trim();
      if (!content) continue;
      const sectionTags = page.sectionTags ?? {};
      // 按 H1-H6 切分段落，每段前拼接该 heading 的 sectionTags（AI 语义标注，§3.3.3）
      const sections = splitByHeadings(content);
      const rendered = sections
        .map(({ heading, level, body }) => {
          const tags = heading
            ? sectionTags[headingKey(level, heading)]
            : undefined;
          const tagLine = tags?.length ? `[TAGS: ${tags.join(', ')}]\n` : '';
          const hashes = '#'.repeat(level);
          return heading
            ? `${tagLine}${hashes} ${heading}\n${body}`.trim()
            : `${tagLine}${body}`.trim();
        })
        .filter(Boolean)
        .join('\n\n');
      blocks.push(`## ${page.title}\n${rendered}`);
    }
    return blocks.join('\n\n');
  }
}
