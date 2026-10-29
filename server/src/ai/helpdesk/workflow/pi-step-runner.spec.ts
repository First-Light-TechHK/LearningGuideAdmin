import type {
  AgentEventEnvelope,
  JsonObject,
} from '../../../contracts/helpdesk-trace';
import { createMemoryAgentEventLog } from '../trace/agent-event.store';
import { RunTrace } from '../trace/run-trace';
import type { AgentStepContext, AgentStepSpec, ModelTarget } from './engine';
import {
  loadPi,
  openRouterSource,
  PiStepRunner,
  type ModelSource,
} from './pi-step-runner';

/**
 * 一个 agent 步 = 一个原样的 pi-agent-core Agent，带四道闸：只给这一步的工具（beforeToolCall 白名单）、
 * 参数枚举锁定（pi 的 TypeBox 校验）、一步至多一个工具调用、finishTurn 一轮即止；期限到就 abort()。
 * 事件映射成 dsh 名字：request/context、request/header、assistant/message、tool/call、tool/result。
 * 真的 pi（ESM，--experimental-vm-modules），模型用 pi 自带的 faux provider；
 * OpenRouter 那条用假的 fetch 看真实请求体，不连网、不用真 key。
 */
const IDS = [
  '0192bbbb-0000-7000-8000-000000000001',
  '0192bbbb-0000-7000-8000-000000000002',
];
const SPEC: AgentStepSpec = {
  system: 'Call pick_faq once.',
  prompt: '{"enquiry":{"message":"reset my password"}}',
  tool: {
    name: 'pick_faq',
    description: 'Pick the FAQ that answers the enquiry, or none.',
    enumArgs: { faqId: [...IDS, 'none'] },
  },
  maxTokens: 80,
};
const TARGET: ModelTarget = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  apiKey: 'test-openrouter-key-local-only',
  baseUrl: 'http://llm.test/api/v1',
};
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01';
const RUN = '0192eeee-0000-7000-8000-000000000030';

type Faux = Awaited<ReturnType<typeof faux>>;
async function faux(tokensPerSecond?: number) {
  const pi = await loadPi();
  const handle = pi.ai.fauxProvider(tokensPerSecond ? { tokensPerSecond } : {});
  const models = pi.ai.createModels();
  models.setProvider(handle.provider);
  const source: ModelSource = () => ({ models, model: handle.getModel() });
  return { pi, handle, source };
}

async function runStep(
  f: Faux,
  options: { signal?: AbortSignal; spec?: AgentStepSpec } = {},
) {
  const log = createMemoryAgentEventLog();
  const trace = new RunTrace(RUN, log);
  const context: AgentStepContext = {
    trace,
    step: 2,
    name: 'pick_faq',
    signal: options.signal ?? new AbortController().signal,
    model: TARGET,
    traceparent: () => TRACEPARENT,
  };
  const outcome = await new PiStepRunner({ source: f.source }).run(
    options.spec ?? SPEC,
    context,
  );
  trace.emit('turn/end', { turn: 1, reason: 'test' });
  await trace.flush();
  const events = (await log.read(RUN)).filter((e) => e.type !== 'turn/end');
  return { outcome, events };
}

const types = (events: AgentEventEnvelope[]) => events.map((e) => e.type);
const of = (events: AgentEventEnvelope[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data);

describe('PiStepRunner on pi-agent-core', () => {
  it('returns the validated pick and records the step in dsh event names', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[1] }, { id: 'call_1' })],
        { stopReason: 'toolUse' },
      ),
      // never asked for: terminate + finishTurn end the step after one request
      f.pi.ai.fauxAssistantMessage('a second request'),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[1] } });
    expect(f.handle.state.callCount).toBe(1);
    expect(types(events)).toEqual([
      'request/context',
      'request/header',
      'assistant/message',
      'tool/call',
      'tool/result',
    ]);
    const [context] = of(events, 'request/context');
    expect(context).toMatchObject({ turn: 1, step: 2, provider: 'faux' });
    expect(of(events, 'request/header')).toEqual([
      { turn: 1, step: 2, reason: 'step', traceparent: TRACEPARENT },
    ]);
    const [reply] = of(events, 'assistant/message');
    expect(reply).toMatchObject({
      turn: 1,
      step: 2,
      stopReason: 'toolUse',
      toolCalls: 1,
    });
    expect(reply.usage).toEqual({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      reasoningTokens: expect.any(Number),
    });
    expect(typeof reply.costUsd).toBe('number');
    expect(of(events, 'tool/call')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_1',
        name: 'pick_faq',
        arguments: JSON.stringify({ faqId: IDS[1] }),
      },
    ]);
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_1',
        name: 'pick_faq',
        result: { faqId: IDS[1] },
      },
    ]);
  });

  it('passes "none" through for the template to decide', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: 'none' })],
        {
          stopReason: 'toolUse',
        },
      ),
    ]);
    expect((await runStep(f)).outcome).toEqual({
      kind: 'called',
      args: { faqId: 'none' },
    });
  });

  it.each([
    [
      'an invented id',
      [
        {
          name: 'pick_faq',
          args: { faqId: '0192bbbb-0000-7000-8000-0000000000ff' },
        },
      ],
      ['invalid_arguments'],
    ],
    [
      'an extra argument',
      [{ name: 'pick_faq', args: { faqId: IDS[0], answer: 'free text' } }],
      ['invalid_arguments'],
    ],
    [
      'a missing argument',
      [{ name: 'pick_faq', args: {} }],
      ['invalid_arguments'],
    ],
    [
      'an unknown tool',
      [{ name: 'refund_order', args: { orderId: '1' } }],
      ['unknown_tool'],
    ],
    [
      'two calls',
      [
        { name: 'pick_faq', args: { faqId: IDS[0] } },
        { name: 'pick_faq', args: { faqId: IDS[1] } },
      ],
      ['too_many_calls', 'too_many_calls'],
    ],
    [
      'a valid call next to an unknown one',
      [
        { name: 'pick_faq', args: { faqId: IDS[0] } },
        { name: 'show_orders', args: {} },
      ],
      ['too_many_calls', 'unknown_tool'],
    ],
  ])(
    'counts %s as no call, with one request only',
    async (_name, calls, codes) => {
      const f = await faux();
      f.handle.setResponses([
        f.pi.ai.fauxAssistantMessage(
          calls.map((c, i) =>
            f.pi.ai.fauxToolCall(c.name, c.args as JsonObject, {
              id: `call_${i}`,
            }),
          ),
          { stopReason: 'toolUse' },
        ),
        f.pi.ai.fauxAssistantMessage(
          [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[0] })],
          {
            stopReason: 'toolUse',
          },
        ),
      ]);
      const { outcome, events } = await runStep(f);
      expect(outcome).toEqual({ kind: 'no_call' });
      expect(f.handle.state.callCount).toBe(1);
      expect(of(events, 'tool/call').map((c) => c.name)).toEqual(
        calls.map((c) => c.name),
      );
      for (const c of of(events, 'tool/call'))
        if (codes[0] !== 'too_many_calls') expect(c.arguments).toBeUndefined();
      const results = of(events, 'tool/result');
      expect(results.map((r) => (r.error as JsonObject).code)).toEqual(codes);
      for (const r of results) {
        expect(r.result).toBeUndefined();
        expect((r.error as JsonObject).name).toBe('ToolError');
      }
    },
  );

  it('never stores model-echoed text from a rejected call (arguments or validation message)', async () => {
    const echo = 'my email is lena@example.com';
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: echo }, { id: 'call_x' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(JSON.stringify(events)).not.toContain('lena@example.com');
    expect(of(events, 'tool/call')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_x',
        name: 'pick_faq',
        rejectedArguments: {
          length: JSON.stringify({ faqId: echo }).length,
        },
      },
    ]);
    // dsh tool/result error is {name, code} only
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_x',
        name: 'pick_faq',
        error: { name: 'ToolError', code: 'invalid_arguments' },
      },
    ]);
  });

  it('records a call cut off by the token limit as truncated', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('pick_faq', { faqId: IDS[0] }, { id: 'call_t' })],
        { stopReason: 'length' },
      ),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(of(events, 'tool/result')).toEqual([
      {
        turn: 1,
        step: 2,
        callId: 'call_t',
        name: 'pick_faq',
        error: { name: 'ToolError', code: 'truncated' },
      },
    ]);
  });

  it('keeps a model-made tool name only when it looks like an identifier', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage(
        [f.pi.ai.fauxToolCall('tell lena@example.com', {}, { id: 'call_n' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const { events } = await runStep(f);
    expect(JSON.stringify(events)).not.toContain('lena@example.com');
    expect(of(events, 'tool/call')[0]).toMatchObject({ name: 'invalid_name' });
    expect(of(events, 'tool/result')[0]).toMatchObject({
      name: 'invalid_name',
      error: { name: 'ToolError', code: 'unknown_tool' },
    });
  });

  it('counts a text answer as no call and keeps the text (learner-derived) on the message', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage('Reset it on the sign-in page.'),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({ kind: 'no_call' });
    expect(of(events, 'assistant/message')[0]).toMatchObject({
      stopReason: 'stop',
      toolCalls: 0,
      text: 'Reset it on the sign-in page.',
    });
  });

  it('reports a provider error as an error', async () => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '429 rate limited upstream',
      }),
    ]);
    const { outcome, events } = await runStep(f);
    expect(outcome).toEqual({
      kind: 'error',
      message: '429 rate limited upstream',
    });
    const [reply] = of(events, 'assistant/message');
    expect(reply).toMatchObject({
      stopReason: 'error',
      error: { name: 'ProviderError', code: 'http_429' },
    });
    // provider error text can carry the request (moderation metadata): never stored
    expect(reply.errorMessage).toBeUndefined();
  });

  it.each([
    ['Provider finish_reason: content_filter', 'content_filter'],
    ['OpenRouter error (503): upstream busy', 'http_503'],
    ['socket hang up', 'provider_error'],
  ])('maps the provider error %j to the code %s', async (message, code) => {
    const f = await faux();
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: message,
      }),
    ]);
    const { events } = await runStep(f);
    expect(of(events, 'assistant/message')[0].error).toEqual({
      name: 'ProviderError',
      code,
    });
  });

  it('aborts the agent when the signal fires and returns at once', async () => {
    const f = await faux(5);
    f.handle.setResponses([
      f.pi.ai.fauxAssistantMessage('a very long answer '.repeat(200)),
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const { outcome } = await runStep(f, { signal: controller.signal });
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not call the model when the signal is already aborted', async () => {
    const f = await faux();
    const controller = new AbortController();
    controller.abort();
    const { outcome, events } = await runStep(f, { signal: controller.signal });
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.handle.state.callCount).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('PiStepRunner through the pi OpenRouter provider (fake fetch)', () => {
  function sse(chunks: unknown[]) {
    const body =
      chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'openai/gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });

  async function call(respond: () => Response) {
    const fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(respond());
    });
    const log = createMemoryAgentEventLog();
    const trace = new RunTrace(RUN, log);
    const outcome = await new PiStepRunner({
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).run(SPEC, {
      trace,
      step: 2,
      name: 'pick_faq',
      signal: new AbortController().signal,
      model: TARGET,
      traceparent: () => TRACEPARENT,
    });
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    return { outcome, fetch, events: await log.read(RUN) };
  }

  it('sends one OpenRouter chat request with the enum-locked tool, required tool choice and the traceparent', async () => {
    const { outcome, fetch, events } = await call(() =>
      sse([
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_9',
              type: 'function',
              function: {
                name: 'pick_faq',
                arguments: JSON.stringify({ faqId: IDS[0] }),
              },
            },
          ],
        }),
        {
          ...chunk({}),
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
          },
        },
      ]),
    );
    expect(outcome).toEqual({ kind: 'called', args: { faqId: IDS[0] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url instanceof Request ? url.url : url.toString()).toBe(
      'http://llm.test/api/v1/chat/completions',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TARGET.apiKey}`);
    expect(headers.get('traceparent')).toBe(TRACEPARENT);
    // no pi attribution headers
    expect(headers.get('http-referer')).toBeNull();
    expect(headers.get('x-openrouter-title')).toBeNull();
    const body = JSON.parse(init?.body as string) as {
      max_completion_tokens?: number;
      max_tokens?: number;
      messages: unknown[];
      tools: {
        function: {
          name: string;
          parameters: { properties: { faqId: { enum: string[] } } };
        };
      }[];
    };
    expect(body).toMatchObject({
      model: 'openai/gpt-4o-mini',
      stream: true,
      temperature: 0,
      tool_choice: 'required',
    });
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(80);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('pick_faq');
    expect(body.tools[0].function.parameters.properties.faqId.enum).toEqual([
      ...IDS,
      'none',
    ]);
    expect(JSON.stringify(body.messages)).toContain('reset my password');
    // the key is never logged
    expect(JSON.stringify(events)).not.toContain(TARGET.apiKey);
    const reply = events.find((e) => e.type === 'assistant/message')?.data;
    expect(reply).toMatchObject({
      usage: {
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      stopReason: 'toolUse',
      model: 'openai/gpt-4o-mini',
    });
    // catalog price for gpt-4o-mini: $0.15 / $0.60 per million tokens
    expect(reply?.costUsd).toBeCloseTo((1000 * 0.15 + 20 * 0.6) / 1e6, 10);
    expect(
      events.find((e) => e.type === 'request/context')?.data,
    ).toMatchObject({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      api: 'openai-completions',
    });
  });

  it.each([429, 500, 503])('does not retry a %s', async (status) => {
    const { outcome, fetch } = await call(
      () =>
        new Response(JSON.stringify({ error: { message: 'busy' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(outcome.kind).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps learner text from a provider error body out of the log', async () => {
    const { outcome, events } = await call(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Input flagged',
              code: 403,
              metadata: {
                raw: 'flagged_input: reset my password',
                flagged_input: 'reset my password',
              },
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(outcome.kind).toBe('error');
    expect(JSON.stringify(events)).not.toContain('reset my password');
    expect(
      events.find((e) => e.type === 'assistant/message')?.data.error,
    ).toEqual({ name: 'ProviderError', code: 'http_403' });
  });

  it('records the cost as unknown (null) for a model missing from the catalog', async () => {
    const fetch = jest.fn(() =>
      Promise.resolve(
        sse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_u',
                type: 'function',
                function: {
                  name: 'pick_faq',
                  arguments: JSON.stringify({ faqId: IDS[0] }),
                },
              },
            ],
          }),
          {
            ...chunk({}),
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0012 },
          },
        ]),
      ),
    );
    const log = createMemoryAgentEventLog();
    const trace = new RunTrace(RUN, log);
    await new PiStepRunner({
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).run(SPEC, {
      trace,
      step: 2,
      name: 'pick_faq',
      signal: new AbortController().signal,
      model: { ...TARGET, model: 'acme/brand-new-model' },
      traceparent: () => TRACEPARENT,
    });
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    const reply = (await log.read(RUN)).find(
      (e) => e.type === 'assistant/message',
    )?.data;
    expect(reply).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 10 },
      costUsd: null,
    });
  });

  it('uses any OpenRouter model id, also one missing from the catalog', async () => {
    const pi = await loadPi();
    const { model } = openRouterSource(pi, {
      ...TARGET,
      model: 'acme/brand-new-model',
    });
    expect(model).toMatchObject({
      id: 'acme/brand-new-model',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: TARGET.baseUrl,
    });
    const known = openRouterSource(pi, TARGET).model;
    expect(known.cost.input).toBeGreaterThan(0);
    expect(known.baseUrl).toBe(TARGET.baseUrl);
  });
});
