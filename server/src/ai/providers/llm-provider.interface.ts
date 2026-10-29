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
}

export interface LlmProvider {
  /** 与 CourseAiConfig.llmProvider 对应的标识，如 "openrouter" */
  readonly name: string;
  /** 流式对话：逐个产出文本增量（delta），正常结束即迭代完成 */
  stream(opts: LlmStreamOptions): AsyncGenerator<string>;
}
