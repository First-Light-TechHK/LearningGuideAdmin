import { OpenRouterProvider } from './openrouter.provider';
import { LlmTimeoutError } from './llm-provider.interface';

function responseWith(data: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of data) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function requestBody(request: RequestInit): unknown {
  if (typeof request.body !== 'string') throw new Error('expected JSON body');
  return JSON.parse(request.body) as unknown;
}

describe('OpenRouterProvider', () => {
  const originalFetch = globalThis.fetch;

  it.each([
    'data: {"error":{"message":"private provider detail"}}\n',
    'data: {"choices":[{"error":{"message":"private provider detail"}}]}\n',
    'data: {broken}\n',
    'data: {"choices":[{"finish_reason":"error"}]}\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
  ])('上游错误或缺少结束标记不伪装成功：%s', async (payload) => {
    globalThis.fetch = jest.fn().mockResolvedValue(responseWith([payload]));
    const read = async () => {
      for await (const event of new OpenRouterProvider().streamEvents({
        model: 'model',
        messages: [],
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
      })) {
        void event;
      }
    };
    await expect(read()).rejects.toThrow(/LLM 上游/);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('兼容旧 stream，并从 SSE 读取 usage 与 finish reason 事件', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        responseWith([
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}\n',
          'data: [DONE]\n',
        ]),
      );
    const provider = new OpenRouterProvider();
    const events = [];
    for await (const event of provider.streamEvents({
      model: 'model',
      messages: [{ role: 'user', content: 'question' }],
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      temperature: 0.4,
      maxOutputTokens: 500,
      reasoningEffort: 'low',
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'delta', content: 'hello' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1 },
      },
      { type: 'finish', reason: 'stop' },
    ]);
    const [, request] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestBody(request)).toMatchObject({
      temperature: 0.4,
      max_tokens: 500,
      stream: true,
      usage: { include: true },
      reasoning: { effort: 'low' },
    });
  });

  it('旧 stream 仍只产出文本 delta', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        responseWith([
          'data: {"choices":[{"delta":{"content":"A"}}]}\n',
          'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n',
          'data: [DONE]\n',
        ]),
      );
    const provider = new OpenRouterProvider();
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      model: 'model',
      messages: [],
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
    }))
      deltas.push(delta);
    expect(deltas).toEqual(['A', 'B']);
    const [, request] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(request.signal).toBeUndefined();
    expect(requestBody(request)).not.toHaveProperty('temperature');
  });

  it('解析没有末尾换行符的最后一个 SSE 事件', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        responseWith([
          'data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}',
        ]),
      );
    const deltas: string[] = [];
    for await (const delta of new OpenRouterProvider().stream({
      model: 'model',
      messages: [],
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
    }))
      deltas.push(delta);
    expect(deltas).toEqual(['tail']);
  });

  it('将取消信号传递给 fetch，并在参数无效时不发起请求', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(responseWith(['data: [DONE]\n']));
    const controller = new AbortController();
    const provider = new OpenRouterProvider();
    const output: string[] = [];
    for await (const delta of provider.stream({
      model: 'model',
      messages: [],
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      signal: controller.signal,
      timeoutMs: 1000,
    }))
      output.push(delta);
    const [, request] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(output).toEqual([]);
    await expect(
      provider
        .stream({
          model: 'model',
          messages: [],
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid',
          maxOutputTokens: 0,
        })
        .next(),
    ).rejects.toThrow('invalid LLM stream options');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('Provider deadline 到期时抛出可识别的 timeout 错误', async () => {
    globalThis.fetch = jest.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true },
          );
        }),
    );
    const provider = new OpenRouterProvider();

    await expect(
      provider
        .stream({
          model: 'model',
          messages: [],
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid',
          timeoutMs: 1,
        })
        .next(),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
  });
});
