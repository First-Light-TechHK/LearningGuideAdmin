import { appendFile, mkdir } from 'node:fs/promises';
import { AiChatLogger } from './ai-chat-logger';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  appendFile: jest.fn(),
}));

const mockedMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockedAppend = appendFile as jest.MockedFunction<typeof appendFile>;

const entry = {
  courseId: 'course-1',
  releaseId: 'release-1',
  mode: 'LECTURE' as const,
  channel: 'admin' as const,
  provider: 'openrouter',
  model: 'openai/gpt-x',
  historyCount: 4,
  latencyMs: 1234,
  status: 'ok' as const,
  question: `第一行\n${'问'.repeat(100)}`,
  answer: '答'.repeat(100),
};

describe('AiChatLogger（§4.4.2 第 7 步）', () => {
  beforeEach(() => {
    mockedMkdir.mockReset().mockResolvedValue(undefined);
    mockedAppend.mockReset().mockResolvedValue(undefined);
  });

  it('按自然日追加一行 JSON，只保留预览与字符数', async () => {
    await new AiChatLogger().write(entry);

    expect(mockedMkdir).toHaveBeenCalledTimes(1);
    expect(mockedAppend).toHaveBeenCalledTimes(1);
    const [file, content, encoding] = mockedAppend.mock.calls[0];
    expect(file).toMatch(/app-logs[\\/]ai-chat-\d{4}-\d{2}-\d{2}\.log$/);
    expect(encoding).toBe('utf8');

    const line = (content as string).trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.courseId).toBe('course-1');
    expect(parsed.releaseId).toBe('release-1');
    expect(parsed.mode).toBe('LECTURE');
    expect(parsed.channel).toBe('admin');
    expect(parsed.model).toBe('openai/gpt-x');
    expect(parsed.status).toBe('ok');
    expect(parsed.questionChars).toBe(entry.question.length);
    expect(parsed.answerChars).toBe(100);
    // 换行被压平，且截断到 80 字 + 省略号
    expect(parsed.question).toBe(`第一行 ${'问'.repeat(76)}…`);
    expect(parsed.answer).toBe(`${'答'.repeat(80)}…`);
    // 字段集合精确匹配：多出任何字段（如 apiKey/baseUrl）都会失败
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'answer',
        'answerChars',
        'channel',
        'courseId',
        'historyCount',
        'latencyMs',
        'mode',
        'model',
        'provider',
        'question',
        'questionChars',
        'releaseId',
        'status',
        'ts',
      ].sort(),
    );
  });

  it('写盘失败仅告警，不向调用方抛出', async () => {
    mockedAppend.mockRejectedValueOnce(new Error('disk full'));
    await expect(new AiChatLogger().write(entry)).resolves.toBeUndefined();
  });
});
