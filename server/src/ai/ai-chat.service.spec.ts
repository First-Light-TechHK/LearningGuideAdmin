import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AiChatLogger, type AiChatLogEntry } from './ai-chat-logger';
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import { ChatStreamDto } from './dto/chat-stream.dto';
import type { LlmStreamOptions } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';
import { RateLimitService } from './rate-limit.service';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_RELEASE = 'release-test';
const LIVE_RELEASE = 'release-live';

type StreamFn = (opts: LlmStreamOptions) => AsyncGenerator<string>;

function setup(stream: StreamFn) {
  const knowledge = {
    getCourse: jest.fn().mockResolvedValue({
      id: COURSE_ID,
      title: '课程',
      currentReleaseId: LIVE_RELEASE,
      aiTestReleaseId: TEST_RELEASE,
      aiTutorOnline: true,
    }),
    getCourseByExternalId: jest.fn().mockResolvedValue({
      id: COURSE_ID,
      title: '课程',
      currentReleaseId: LIVE_RELEASE,
      aiTestReleaseId: null,
      aiTutorOnline: true,
    }),
    retrieveChunks: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeClient;

  const configs = {
    resolveRuntime: jest.fn().mockResolvedValue({
      provider: 'openrouter',
      model: 'openai/gpt-x',
      apiKey: 'sk-secret',
      baseUrl: 'https://example.invalid',
    }),
    resolvePrompts: jest
      .fn()
      .mockResolvedValue({ systemPrompt: 'SYS', welcomeMsg: '' }),
  } as unknown as AiConfigService;

  const registry = {
    get: jest.fn(() => ({ name: 'openrouter', stream })),
  } as unknown as ProviderRegistry;

  const rateLimit = {
    assertAllowed: jest.fn().mockResolvedValue(undefined),
  } as unknown as RateLimitService;

  const chatLogger = {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as AiChatLogger;

  const service = new AiChatService(
    knowledge,
    configs,
    registry,
    rateLimit,
    chatLogger,
  );
  const write = chatLogger.write as jest.MockedFunction<AiChatLogger['write']>;
  const entryOf = (): AiChatLogEntry =>
    write.mock.calls[0][0] as unknown as AiChatLogEntry;
  return { service, write, entryOf, knowledge, configs, rateLimit };
}

function dto(history: ChatStreamDto['history'] = []): ChatStreamDto {
  return {
    courseId: COURSE_ID,
    message: '什么是斯多葛主义？',
    mode: 'LECTURE',
    history,
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  const chunks: string[] = [];
  for await (const delta of gen) chunks.push(delta);
  return chunks.join('');
}

describe('AiChatService 对话日志（§4.4.2 第 7 步）', () => {
  it('正常结束：记录 ok + 完整回答与截断后的 history 条数', async () => {
    const { service, write, entryOf } = setup(async function* () {
      yield 'Hello';
      yield ' world';
    });

    const history = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: `h${i}`,
    }));

    await expect(collect(service.streamChat(dto(history)))).resolves.toBe(
      'Hello world',
    );

    expect(write).toHaveBeenCalledTimes(1);
    const entry = entryOf();
    expect(entry.status).toBe('ok');
    expect(entry.courseId).toBe(COURSE_ID);
    expect(entry.releaseId).toBe(TEST_RELEASE);
    expect(entry.provider).toBe('openrouter');
    expect(entry.model).toBe('openai/gpt-x');
    expect(entry.historyCount).toBe(10);
    expect(entry.question).toBe('什么是斯多葛主义？');
    expect(entry.answer).toBe('Hello world');
    expect(entry.error).toBeUndefined();
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Provider 持续失败：重试后抛出，日志记 error 与错误原因', async () => {
    let calls = 0;
    const { service, write, entryOf } = setup(
      async function* (): AsyncGenerator<string> {
        calls += 1;
        throw new Error('upstream 502');
      },
    );

    await expect(collect(service.streamChat(dto()))).rejects.toThrow(
      'upstream 502',
    );
    expect(calls).toBe(3); // 首次 + 2 次重试
    expect(write).toHaveBeenCalledTimes(1);
    const entry = entryOf();
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('upstream 502');
    expect(entry.answer).toBe('');
  });

  it('客户端提前断开：日志记 aborted', async () => {
    const { service, write, entryOf } = setup(async function* () {
      yield 'A';
      yield 'B';
    });

    const gen = service.streamChat(dto());
    await expect(gen.next()).resolves.toEqual({ value: 'A', done: false });
    await gen.return(undefined);

    expect(write).toHaveBeenCalledTimes(1);
    const entry = entryOf();
    expect(entry.status).toBe('aborted');
    expect(entry.answer).toBe('A');
  });

  it('课程不存在：日志记 error，releaseId 为空', async () => {
    const { service, write, entryOf, knowledge } = setup(async function* () {
      yield '';
    });
    (knowledge.getCourse as jest.Mock).mockResolvedValueOnce(null);
    await expect(collect(service.streamChat(dto()))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const entry = entryOf();
    expect(entry.status).toBe('error');
    expect(entry.releaseId).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('AiChatService 学员端对话（2026-10-22）', () => {
  const learnerDto = (over: Record<string, unknown> = {}) => ({
    externalCourseId: 'epicureanism',
    message: 'What is pleasure?',
    mode: 'LECTURE' as const,
    locale: 'en-GB' as const,
    history: [],
    ...over,
  });

  it('Online 关闭时拒绝，并记录 learner 错误日志', async () => {
    const { service, write, entryOf, knowledge } = setup(async function* () {
      yield '';
    });
    (knowledge.getCourseByExternalId as jest.Mock).mockResolvedValue({
      id: COURSE_ID,
      currentReleaseId: LIVE_RELEASE,
      aiTutorOnline: false,
    });

    await expect(
      collect(service.streamLearnerChat(learnerDto())),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(write).toHaveBeenCalledTimes(1);
    const entry = entryOf();
    expect(entry.channel).toBe('learner');
    expect(entry.status).toBe('error');
  });

  it('无上线 Release 时拒绝', async () => {
    const { service, knowledge } = setup(async function* () {
      yield '';
    });
    (knowledge.getCourseByExternalId as jest.Mock).mockResolvedValue({
      id: COURSE_ID,
      currentReleaseId: null,
      aiTutorOnline: true,
    });

    await expect(
      collect(service.streamLearnerChat(learnerDto())),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('只读 currentReleaseId（忽略 aiTestReleaseId）并注入英文语言指令', async () => {
    let systemPrompt = '';
    const { service, knowledge, configs } = setup(
      async function* (opts: LlmStreamOptions) {
        systemPrompt = opts.messages[0]?.content ?? '';
        yield 'ok';
      },
    );
    (knowledge.getCourseByExternalId as jest.Mock).mockResolvedValue({
      id: COURSE_ID,
      currentReleaseId: LIVE_RELEASE,
      aiTestReleaseId: TEST_RELEASE,
      aiTutorOnline: true,
    });

    await expect(
      collect(service.streamLearnerChat(learnerDto())),
    ).resolves.toBe('ok');
    expect(knowledge.getCourseByExternalId).toHaveBeenCalledWith(
      'epicureanism',
    );
    expect(configs.resolveRuntime).toHaveBeenCalledWith(
      COURSE_ID,
      LIVE_RELEASE,
      'LECTURE',
    );
    expect(configs.resolvePrompts).toHaveBeenCalledWith(
      COURSE_ID,
      LIVE_RELEASE,
      'LECTURE',
    );
    expect(systemPrompt).toContain("Answer in the language of the student's latest message.");
  });

  it('直播间流量走独立限流槽位（study-group），默认按 portal', async () => {
    const { service, knowledge, rateLimit } = setup(async function* () {
      yield 'ok';
    });
    (knowledge.getCourseByExternalId as jest.Mock).mockResolvedValue({
      id: COURSE_ID,
      currentReleaseId: LIVE_RELEASE,
      aiTutorOnline: true,
    });

    await collect(service.streamLearnerChat(learnerDto()));
    expect(rateLimit.assertAllowed).toHaveBeenLastCalledWith(
      COURSE_ID,
      'portal',
      undefined,
    );

    await collect(
      service.streamLearnerChat(learnerDto({ channel: 'study-group' })),
    );
    expect(rateLimit.assertAllowed).toHaveBeenLastCalledWith(
      COURSE_ID,
      'study-group',
      undefined,
    );
  });

  it('后台测试对话走独立的 admin-test 限流槽位，不占学员额度（QA A2）', async () => {
    const { service, rateLimit } = setup(async function* () {
      yield 'ok';
    });
    await collect(service.streamChat(dto()));
    expect(rateLimit.assertAllowed).toHaveBeenLastCalledWith(
      expect.any(String),
      'admin-test',
      undefined,
    );
  });
});
