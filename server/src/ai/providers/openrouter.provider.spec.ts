import { OpenRouterProvider } from './openrouter.provider';

/**
 * OpenRouter 适配器的非流式调用（Helpdesk addendum §C 结构化输出）。
 * fetch 全部 mock；API key 是本地测试值。
 */
describe('OpenRouterProvider.complete', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function mockFetch(response: Response) {
    const fn = jest.fn().mockResolvedValue(response);
    global.fetch = fn;
    return fn;
  }

  const base = {
    model: 'test/model',
    apiKey: 'test-openrouter-key-local-only',
    baseUrl: 'http://llm.test/v1',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('posts a non-streaming chat completion with response_format and returns the text', async () => {
    const fetchMock = mockFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"qaId":null}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const controller = new AbortController();
    const format = {
      type: 'json_schema',
      json_schema: { name: 'x', schema: {} },
    };
    const text = await new OpenRouterProvider().complete({
      ...base,
      responseFormat: format,
      temperature: 0,
      maxTokens: 50,
      signal: controller.signal,
    });
    expect(text).toBe('{"qaId":null}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://llm.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-openrouter-key-local-only',
    );
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'test/model',
      messages: base.messages,
      stream: false,
      response_format: format,
      temperature: 0,
      max_tokens: 50,
    });
  });

  it('throws on an upstream error or an empty answer', async () => {
    mockFetch(new Response('nope', { status: 500 }));
    await expect(new OpenRouterProvider().complete(base)).rejects.toThrow();
    mockFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(new OpenRouterProvider().complete(base)).rejects.toThrow();
  });
});
