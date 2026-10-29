import { createMemoryAgentEventLog } from '../trace/agent-event.store';
import { RunTrace } from '../trace/run-trace';
import {
  runWorkflow,
  type AgentStepRunner,
  type ModelTarget,
  type WorkflowTemplate,
} from './engine';

/**
 * 工作流层（我们写死的步骤表）：下一步永远由我们的代码按上一步校验过的结果决定，模型从不决定；
 * 每个 agent 步交给 runner（pi Agent）只做这一步；任何失败都结束为 error / timeout / aborted。
 */
const RUN = '0192eeee-0000-7000-8000-000000000020';
const MODEL: ModelTarget = {
  provider: 'openrouter',
  model: 'test/model',
  apiKey: 'test-key-local-only',
  baseUrl: 'http://llm.test/v1',
};

type State = { trail: string[]; pick?: string };

const template: WorkflowTemplate<State> = {
  name: 'demo',
  start: 'first',
  steps: {
    first: {
      kind: 'code',
      run: (state) =>
        Promise.resolve({
          state: { trail: [...state.trail, 'first'] },
          then: { next: 'choose' },
          output: { found: 2 },
        }),
    },
    choose: {
      kind: 'agent',
      prepare: () => ({
        system: 'pick one',
        prompt: '{"options":["a","b"]}',
        tool: {
          name: 'pick',
          description: 'Pick an option',
          enumArgs: { option: ['a', 'b', 'none'] },
        },
        maxTokens: 20,
      }),
      decide: (state, args) =>
        args && args.option !== 'none'
          ? { state: { ...state, pick: args.option }, then: { next: 'last' } }
          : { state, then: { end: 'no_match' } },
    },
    last: {
      kind: 'code',
      run: (state) =>
        Promise.resolve({
          state: { ...state, trail: [...state.trail, 'last'] },
          then: { end: 'answered' },
        }),
    },
  },
};

function setup(
  runner?: AgentStepRunner,
  signal = new AbortController().signal,
) {
  const log = createMemoryAgentEventLog();
  const trace = new RunTrace(RUN, log);
  const deps = {
    trace,
    runner,
    model: MODEL,
    signal,
    stepTimeoutMs: () => 3_000,
    traceparent: () =>
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
  const events = async () => {
    trace.emit('turn/end', { turn: 1, reason: 'test' });
    await trace.flush();
    return (await log.read(RUN)).filter((e) => e.type !== 'turn/end');
  };
  return { deps, events };
}

describe('runWorkflow', () => {
  it('v5: hands the extras (lists, short texts, flags) to decide, and logs the texts only by length', async () => {
    const seen: unknown[] = [];
    const withExtras: WorkflowTemplate<State> = {
      ...template,
      steps: {
        ...template.steps,
        choose: {
          ...(template.steps.choose as Extract<
            (typeof template.steps)[string],
            { kind: 'agent' }
          >),
          decide: (state, args, extras) => {
            seen.push(extras);
            return {
              state: { ...state, pick: args?.option },
              then: { end: 'answered' },
            };
          },
        },
      },
    };
    const run = jest.fn<
      ReturnType<AgentStepRunner['run']>,
      Parameters<AgentStepRunner['run']>
    >(() =>
      Promise.resolve({
        kind: 'called',
        args: { option: 'a' },
        extras: {
          lists: { blocks: ['b1'] },
          texts: { reply: 'Hi Lena!' },
          flags: { covered: true },
        },
      }),
    );
    const { deps, events } = setup({ run });
    await runWorkflow(withExtras, { trail: [] }, deps);
    expect(seen).toEqual([
      {
        lists: { blocks: ['b1'] },
        texts: { reply: 'Hi Lena!' },
        flags: { covered: true },
      },
    ]);
    const end = (await events()).find(
      (e) => e.type === 'step/end' && e.data.name === 'choose',
    );
    expect(end?.data).toMatchObject({
      args: { option: 'a' },
      lists: { blocks: ['b1'] },
      flags: { covered: true },
      texts: { reply: { length: 8 } },
    });
    expect(JSON.stringify(end)).not.toContain('Lena');
  });

  it('walks the step table the code chooses and records each step', async () => {
    const run = jest.fn<
      ReturnType<AgentStepRunner['run']>,
      Parameters<AgentStepRunner['run']>
    >(() => Promise.resolve({ kind: 'called', args: { option: 'b' } }));
    const { deps, events } = setup({ run });
    const result = await runWorkflow(template, { trail: [] }, deps);
    expect(result).toEqual({
      state: { trail: ['first', 'last'], pick: 'b' },
      reason: 'answered',
      trail: ['first', 'choose', 'last'],
    });
    const [spec, ctx] = run.mock.calls[0];
    expect(spec.tool.enumArgs).toEqual({ option: ['a', 'b', 'none'] });
    expect(ctx).toMatchObject({ step: 2, name: 'choose', model: MODEL });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.traceparent()).toMatch(/^00-/);
    expect((await events()).map((e) => [e.type, e.data])).toEqual([
      ['step/start', { turn: 1, step: 1, name: 'first', kind: 'code' }],
      [
        'step/end',
        {
          turn: 1,
          step: 1,
          name: 'first',
          kind: 'code',
          then: { next: 'choose' },
          output: { found: 2 },
        },
      ],
      [
        'step/start',
        { turn: 1, step: 2, name: 'choose', kind: 'agent', tools: ['pick'] },
      ],
      [
        'step/end',
        {
          turn: 1,
          step: 2,
          name: 'choose',
          kind: 'agent',
          outcome: 'called',
          args: { option: 'b' },
          then: { next: 'last' },
        },
      ],
      ['step/start', { turn: 1, step: 3, name: 'last', kind: 'code' }],
      [
        'step/end',
        {
          turn: 1,
          step: 3,
          name: 'last',
          kind: 'code',
          then: { end: 'answered' },
        },
      ],
    ]);
  });

  it('lets the template decide on no tool call', async () => {
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'no_call' }) });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'no_match',
    });
  });

  it('ends as error when the step fails, whatever the template would say', async () => {
    const { deps, events } = setup({
      run: () => Promise.resolve({ kind: 'error', message: '502' }),
    });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    expect((await events()).at(-1)?.data).toMatchObject({
      outcome: 'error',
      then: { end: 'error' },
    });
  });

  it('ends as timeout when the step runs past its time, even if the runner never settles', async () => {
    let signal: AbortSignal | undefined;
    const { deps } = setup({
      run: (_spec, context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      },
    });
    const started = Date.now();
    await expect(
      runWorkflow(
        template,
        { trail: [] },
        { ...deps, stepTimeoutMs: () => 20 },
      ),
    ).resolves.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  it('computes the step time when the step starts', async () => {
    const stepTimeoutMs = jest.fn(() => 3_000);
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'no_call' }) });
    await runWorkflow(template, { trail: [] }, { ...deps, stepTimeoutMs });
    expect(stepTimeoutMs).toHaveBeenCalledTimes(1);
  });

  it('ends as aborted when the caller goes away mid-step', async () => {
    const controller = new AbortController();
    const { deps } = setup(
      { run: () => new Promise(() => undefined) },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'aborted' });
  });

  it('treats a runner that reports aborted as timed out when the caller is still there', async () => {
    const { deps } = setup({ run: () => Promise.resolve({ kind: 'aborted' }) });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'timeout' });
  });

  it('does not start an agent step once the caller has gone', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = jest.fn();
    const { deps } = setup({ run }, controller.signal);
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'aborted' });
    expect(run).not.toHaveBeenCalled();
  });

  it('ends as error on an unknown step, a missing runner, or a loop past the table size', async () => {
    const { deps } = setup();
    await expect(
      runWorkflow({ ...template, start: 'nowhere' }, { trail: [] }, deps),
    ).resolves.toMatchObject({ reason: 'error' });
    await expect(
      runWorkflow(template, { trail: [] }, deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    const loop: WorkflowTemplate<State> = {
      name: 'loop',
      start: 'again',
      steps: {
        again: {
          kind: 'code',
          run: (state) => Promise.resolve({ state, then: { next: 'again' } }),
        },
      },
    };
    const looping = setup();
    await expect(
      runWorkflow(loop, { trail: [] }, looping.deps),
    ).resolves.toMatchObject({
      reason: 'error',
    });
    expect(
      (await looping.events()).filter((e) => e.type === 'step/start'),
    ).toHaveLength(1);
  });
});
