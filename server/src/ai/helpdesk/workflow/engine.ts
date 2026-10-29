import type {
  JsonObject,
  TurnEndReason,
} from '../../../contracts/helpdesk-trace';
import type { RunTrace } from '../trace/run-trace';

/**
 * 工作流层（helpdesk-agent-v2-pi-dsh §1「两层」）：每个工作流是一张写死的步骤表，
 * 下一步永远由我们的代码按上一步校验过的结果决定，模型从不决定。
 * - code 步：检索、校验、查订单……纯代码；
 * - agent 步：交给 AgentStepRunner（pi-agent-core 的 Agent，原样使用）只做这一步，
 *   只给这一步的工具，参数全部枚举锁定；runner 只回报「调了什么」，怎么走由 decide 决定。
 * 新模板（订单状态卡片、只给链接、低置信度选项）= 新的一张步骤表，不动这里与 runner。
 */
export type ModelTarget = {
  provider: 'openrouter';
  model: string;
  apiKey: string;
  baseUrl: string;
};

export type AgentStepSpec = {
  /** 不含任何学员原文。 */
  system: string;
  /** 学员原文只放在这里（不可信输入）。 */
  prompt: string;
  /** 这一步唯一的工具；参数全部是枚举锁定的字符串。 */
  tool: {
    name: string;
    description: string;
    enumArgs: Record<string, readonly string[]>;
  };
  maxTokens: number;
};

export type AgentStepOutcome =
  | { kind: 'called'; args: Record<string, string> }
  | { kind: 'no_call' }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

export type AgentStepContext = {
  trace: RunTrace;
  step: number;
  name: string;
  signal: AbortSignal;
  model: ModelTarget;
  /** 发往模型的 W3C traceparent（每次请求一个新 span）。 */
  traceparent: () => string;
};

/** 跑一个 agent 步；实现见 pi-step-runner.ts（ESM 的 pi 用 import() 加载，单测换假的）。 */
export interface AgentStepRunner {
  run(
    spec: AgentStepSpec,
    context: AgentStepContext,
  ): Promise<AgentStepOutcome>;
}

export type Transition = { next: string } | { end: TurnEndReason };

export type CodeStep<S> = {
  kind: 'code';
  run(state: S): Promise<{ state: S; then: Transition; output?: JsonObject }>;
};

export type AgentStep<S> = {
  kind: 'agent';
  prepare(state: S): AgentStepSpec;
  /** args 是 runner 校验过的工具参数；没有有效调用时为 null。 */
  decide(
    state: S,
    args: Record<string, string> | null,
  ): { state: S; then: Transition };
};

export type WorkflowTemplate<S> = {
  name: string;
  start: string;
  steps: Record<string, CodeStep<S> | AgentStep<S>>;
};

export type WorkflowDeps = {
  trace: RunTrace;
  runner?: AgentStepRunner;
  model?: ModelTarget;
  /** 调用方放弃（Portal 断开）：不再开新步，正在跑的 agent 步立即放弃，结束为 aborted。 */
  signal?: AbortSignal;
  /** 一个 agent 步最多跑多久（开步时现算：min(3 s, 离总期限还剩)）；到时结束为 timeout。 */
  stepTimeoutMs: () => number;
  traceparent: () => string;
};

const ABORTED: AgentStepOutcome = { kind: 'aborted' };

/** runner 不理 signal 也不等它：abort 一到就当 aborted 处理。 */
function untilAborted(
  work: Promise<AgentStepOutcome>,
  signal: AbortSignal,
): Promise<AgentStepOutcome> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<AgentStepOutcome>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([
    work.catch((error: unknown) => ({
      kind: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    })),
    aborted,
  ]).finally(() => signal.removeEventListener('abort', onAbort));
}

export async function runWorkflow<S>(
  template: WorkflowTemplate<S>,
  initial: S,
  deps: WorkflowDeps,
): Promise<{ state: S; reason: TurnEndReason; trail: string[] }> {
  const { trace } = deps;
  const turn = trace.turn;
  let state = initial;
  let name = template.start;
  const trail: string[] = [];
  // 每一步至多走一次：步骤表多大，就最多走多少步
  for (let taken = 0; taken < Object.keys(template.steps).length; taken++) {
    const step = Object.hasOwn(template.steps, name)
      ? template.steps[name]
      : undefined;
    if (!step) return { state, reason: 'error', trail };
    trail.push(name);
    const no = trace.nextStep();
    let then: Transition;
    if (step.kind === 'code') {
      trace.emit('step/start', { turn, step: no, name, kind: 'code' });
      try {
        const result = await step.run(state);
        state = result.state;
        then = result.then;
        trace.emit('step/end', {
          turn,
          step: no,
          name,
          kind: 'code',
          then,
          ...(result.output ? { output: result.output } : {}),
        });
      } catch (error) {
        then = { end: 'error' };
        trace.emit('step/end', {
          turn,
          step: no,
          name,
          kind: 'code',
          then,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            code: 'step_failed',
          },
        });
      }
    } else {
      const spec = step.prepare(state);
      trace.emit('step/start', {
        turn,
        step: no,
        name,
        kind: 'agent',
        tools: [spec.tool.name],
      });
      const timeout = AbortSignal.timeout(Math.max(1, deps.stepTimeoutMs()));
      const signal = deps.signal
        ? AbortSignal.any([timeout, deps.signal])
        : timeout;
      const outcome = signal.aborted
        ? ABORTED
        : deps.runner && deps.model
          ? await untilAborted(
              deps.runner.run(spec, {
                trace,
                step: no,
                name,
                signal,
                model: deps.model,
                traceparent: deps.traceparent,
              }),
              signal,
            )
          : ({ kind: 'error', message: 'no runner' } as const);
      if (outcome.kind === 'aborted')
        then = { end: deps.signal?.aborted ? 'aborted' : 'timeout' };
      else if (outcome.kind === 'error') then = { end: 'error' };
      else {
        const decided = step.decide(
          state,
          outcome.kind === 'called' ? outcome.args : null,
        );
        state = decided.state;
        then = decided.then;
      }
      trace.emit('step/end', {
        turn,
        step: no,
        name,
        kind: 'agent',
        outcome: outcome.kind,
        ...(outcome.kind === 'called' ? { args: outcome.args } : {}),
        then,
      });
    }
    if ('end' in then) return { state, reason: then.end, trail };
    name = then.next;
  }
  return { state, reason: 'error', trail };
}
