import type {
  AgentTool,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core' with { 'resolution-mode': 'import' };
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

import type { JsonObject } from '../../../contracts/helpdesk-trace';
import type {
  AgentStepContext,
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
  ModelTarget,
} from './engine';

/**
 * agent 步的运行时：@earendil-works/pi-agent-core 的 Agent，原样使用（不打补丁、不 fork）。
 * pi 只发 ESM，这里用真正的 import() 加载（server 是 nodenext 的 CommonJS）；单测可换 source。
 *
 * 闸：只给这一步的工具，参数是 StringEnum（pi 的 TypeBox 校验）；beforeToolCall 白名单 + 一步至多
 * 一个调用；工具结果 terminate:true，且 finishTurn 一律 end（一轮、一次请求）；signal 一到 abort()；
 * 不重试（maxRetries 0），能要求就要求必须调工具（tool_choice required）；不发 pi 的署名头。
 *
 * 事件（dsh 名字，一个订阅者）：请求发出前 request/context + request/header（含 traceparent，
 * 从不含 key 或鉴权头）；message_end → assistant/message（usage、costUsd = pi usage.cost.total、
 * stopReason）；tool_execution_start → tool/call（arguments 为模型给的参数 JSON）；
 * tool_execution_end → tool/result（失败时 error {name, code}）。step/start、step/end 由工作流写
 * （每个 agent 步正好是 pi 的一个 turn，code 步也要有）。
 */
// 依次加载：共用 typebox 等依赖，并发 import() 在 Jest 的 ESM 加载器里会撞上链接竞争
async function importPi() {
  const core = await import('@earendil-works/pi-agent-core');
  const ai = await import('@earendil-works/pi-ai');
  const openrouter = await import('@earendil-works/pi-ai/providers/openrouter');
  return { core, ai, openrouter };
}
export type PiModules = Awaited<ReturnType<typeof importPi>>;

let loading: Promise<PiModules> | undefined;

/** 加载一次 pi（失败下次再试）。 */
export function loadPi(): Promise<PiModules> {
  loading ??= importPi();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

export type StreamSource = {
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
};
export type ModelSource = (
  pi: PiModules,
  target: ModelTarget,
) => { models: StreamSource; model: Model<Api> };

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let openRouterModels: ReturnType<PiModules['ai']['createModels']> | undefined;

/**
 * pi-ai 的 OpenRouter provider。模型 id 随 HELPDESK_SUGGEST_MODEL 任意：目录里有就用目录的价格
 * （openai-completions 接口），没有就按 OpenRouter 的 chat completions 现造；base URL 每次现读。
 */
export const openRouterSource: ModelSource = (pi, target) => {
  if (!openRouterModels) {
    openRouterModels = pi.ai.createModels();
    openRouterModels.setProvider(pi.openrouter.openrouterProvider());
  }
  const known = openRouterModels.getModel('openrouter', target.model);
  const model: Model<Api> =
    known?.api === 'openai-completions'
      ? { ...known, baseUrl: target.baseUrl }
      : {
          id: target.model,
          name: target.model,
          api: 'openai-completions',
          provider: 'openrouter',
          baseUrl: target.baseUrl,
          reasoning: false,
          input: ['text'],
          cost: known?.cost ?? NO_COST,
          contextWindow: known?.contextWindow ?? 128_000,
          maxTokens: known?.maxTokens ?? 4_096,
        };
  return { models: openRouterModels, model };
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function assistantData(message: AssistantMessage): JsonObject {
  const usage = message.usage;
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    model: message.responseModel ?? message.model,
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      reasoningTokens: usage.reasoning ?? 0,
    },
    costUsd: usage.cost.total,
    stopReason: message.stopReason,
    toolCalls: message.content.filter((block) => block.type === 'toolCall')
      .length,
    ...(message.durationMs !== undefined
      ? { durationMs: message.durationMs }
      : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    // 模型的文字可能复述学员原文：按学员原文对待（90 天清空、导出脱敏）
    ...(text ? { text: clip(text, 500) } : {}),
    ...(message.errorMessage
      ? { errorMessage: clip(message.errorMessage, 300) }
      : {}),
  };
}

export type PiStepRunnerOptions = {
  load?: () => Promise<PiModules>;
  source?: ModelSource;
  /** 测试用：替换 provider 的 HTTP fetch。 */
  fetch?: typeof fetch;
};

export class PiStepRunner implements AgentStepRunner {
  private readonly load: () => Promise<PiModules>;
  private readonly source: ModelSource;

  constructor(private readonly options: PiStepRunnerOptions = {}) {
    this.load = options.load ?? loadPi;
    this.source = options.source ?? openRouterSource;
  }

  async run(
    spec: AgentStepSpec,
    context: AgentStepContext,
  ): Promise<AgentStepOutcome> {
    const pi = await this.load();
    const { signal, trace, step } = context;
    if (signal.aborted) return { kind: 'aborted' };
    const { models, model } = this.source(pi, context.model);
    const allowed = [spec.tool.name];
    let closed = false;
    let picked: Record<string, string> | null = null;
    let lastStop: AssistantMessage['stopReason'] | null = null;
    const blocked = new Map<string, string>();
    const emit = (type: Parameters<typeof trace.emit>[0], data: JsonObject) => {
      if (!closed) trace.emit(type, { turn: trace.turn, step, ...data });
    };

    const tool: AgentTool = {
      name: spec.tool.name,
      label: spec.tool.name,
      description: spec.tool.description,
      parameters: pi.ai.Type.Object(
        Object.fromEntries(
          Object.entries(spec.tool.enumArgs).map(([key, values]) => [
            key,
            pi.ai.StringEnum([...values]),
          ]),
        ),
        { additionalProperties: false },
      ),
      execute: (_id, args) => {
        // pi 已按 TypeBox 校验：每个参数都是枚举里的字符串
        picked = { ...(args as Record<string, string>) };
        return Promise.resolve({
          content: [{ type: 'text', text: 'Recorded.' }],
          details: picked,
          terminate: true,
        });
      },
    };

    const agent = new pi.core.Agent({
      initialState: {
        systemPrompt: spec.system,
        model,
        tools: [tool],
        thinkingLevel: 'off',
      },
      streamFn: (requestModel, transcript, streamOptions) => {
        const traceparent = context.traceparent();
        emit('request/context', {
          provider: requestModel.provider,
          model: requestModel.id,
          api: requestModel.api,
        });
        emit('request/header', { reason: 'step', traceparent });
        return models.streamSimple(requestModel, transcript, {
          ...streamOptions,
          apiKey: context.model.apiKey,
          headers: { ...streamOptions?.headers, traceparent },
          temperature: 0,
          maxTokens: spec.maxTokens,
          maxRetries: 0,
          // openai-completions 原样转成 tool_choice（SimpleStreamOptions 的类型只列 auto / none）
          toolChoice: 'required' as SimpleStreamOptions['toolChoice'],
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
      },
      beforeToolCall: ({ toolCall, assistantMessage }) => {
        const calls = assistantMessage.content.filter(
          (block) => block.type === 'toolCall',
        ).length;
        const code = !allowed.includes(toolCall.name)
          ? 'not_allowed'
          : calls !== 1
            ? 'too_many_calls'
            : null;
        if (!code) return Promise.resolve(undefined);
        blocked.set(toolCall.id, code);
        const result: BeforeToolCallResult = {
          block: true,
          reason:
            code === 'too_many_calls'
              ? 'Call exactly one tool.'
              : 'This tool is not available in this step.',
          terminate: true,
        };
        return Promise.resolve(result);
      },
      finishTurn: () => ({ action: 'end' }),
      toolExecution: 'sequential',
      identity: { attribution: null },
    });

    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastStop = event.message.stopReason;
        emit('assistant/message', assistantData(event.message));
      } else if (event.type === 'tool_execution_start') {
        emit('tool/call', {
          callId: event.toolCallId,
          name: event.toolName,
          arguments: JSON.stringify(event.args ?? {}),
        });
      } else if (event.type === 'tool_execution_end') {
        const base = { callId: event.toolCallId, name: event.toolName };
        if (!event.isError) {
          emit('tool/result', {
            ...base,
            result: (event.result as { details: JsonObject }).details,
          });
          return;
        }
        const code =
          blocked.get(event.toolCallId) ??
          (!allowed.includes(event.toolName)
            ? 'unknown_tool'
            : signal.aborted
              ? 'aborted'
              : lastStop === 'length'
                ? 'truncated'
                : 'invalid_arguments');
        const content = (event.result as { content?: { text?: string }[] })
          .content;
        emit('tool/result', {
          ...base,
          error: {
            name: 'ToolError',
            code,
            message: clip(content?.[0]?.text ?? '', 300),
          },
        });
      }
    });

    // 中止后到的事件不再记（工作流已经写了 step/end）；不等 provider 收尾，立即返回
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => {
        closed = true;
        agent.abort();
        resolve();
      };
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const prompting = agent.prompt(spec.prompt);
      prompting.catch(() => undefined);
      await Promise.race([prompting, aborted]);
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      closed = true;
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted || lastStop === 'aborted') return { kind: 'aborted' };
    const last = agent.state.messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    if (!last || last.stopReason === 'error')
      return {
        kind: 'error',
        message: clip(last?.errorMessage ?? 'no response', 300),
      };
    return picked ? { kind: 'called', args: picked } : { kind: 'no_call' };
  }
}
