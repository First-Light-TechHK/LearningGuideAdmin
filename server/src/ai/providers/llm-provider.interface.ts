/**
 * LLM Provider 适配器接口（开发文档 §1.3 架构原则 1：策略模式，Provider 可替换；
 * §4.4.2 第 5 步：代理转发经适配器调用实际 API）。
 * 业务代码只依赖本接口，禁止直接耦合厂商 SDK。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmStreamOptions {
  model: string;
  messages: LlmMessage[];
  /** 实际调用使用的明文 key（课程级解密值或 env 全局 key），绝不落日志/响应 */
  apiKey: string;
  baseUrl: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: Exclude<LlmStreamEvent, { type: 'delta' }>) => void;
}

export class LlmTimeoutError extends Error {
  constructor() {
    super('LLM request timed out');
    this.name = 'LlmTimeoutError';
  }
}

export type LlmStreamEvent =
  | { type: 'delta'; content: string }
  | {
      type: 'usage';
      usage: { inputTokens?: number; outputTokens?: number };
    }
  | { type: 'finish'; reason: string | null };

export interface LlmEventProvider {
  /** Optional metadata stream; legacy callers continue using LlmProvider.stream. */
  streamEvents?(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent>;
}

export interface LlmProvider extends LlmEventProvider {
  /** 与 CourseAiConfig.llmProvider 对应的标识，如 "openrouter" */
  readonly name: string;
  /** 流式对话：逐个产出文本增量（delta），正常结束即迭代完成 */
  stream(opts: LlmStreamOptions): AsyncGenerator<string>;
}
