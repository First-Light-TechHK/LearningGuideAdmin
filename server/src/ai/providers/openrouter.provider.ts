import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  LlmCompleteOptions,
  LlmMessage,
  LlmProvider,
  LlmStreamOptions,
} from './llm-provider.interface';

/**
 * OpenRouter 适配器（§4.4.2 第 5 步；§12 事项 #2 拍板：OpenAI 兼容接口）。
 * 走 /chat/completions 流式协议（SSE），不依赖任何厂商 SDK。
 * 同一适配器亦兼容 OpenAI 官方/其他 OpenAI-compatible 端点（改 baseUrl 即可）。
 */
@Injectable()
export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';

  async *stream(opts: LlmStreamOptions): AsyncGenerator<string> {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages satisfies LlmMessage[],
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      // 状态码透传语义：4xx/5xx 均视为上游调用失败（对外消息不带上游细节，§9）
      throw new HttpException(
        `LLM 上游返回 ${res.status}`,
        res.status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_GATEWAY,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按行解析 SSE：仅消费完整行，残段留在 buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // 非 JSON 心跳/注释行：忽略
        }
      }
    }
  }

  /**
   * 非流式调用（Helpdesk 推荐，2026-10-28）：可带 response_format（结构化输出）与 AbortSignal。
   * 上游失败或没有内容时抛错，由调用方决定降级。
   */
  async complete(opts: LlmCompleteOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages satisfies LlmMessage[],
      stream: false,
    };
    if (opts.responseFormat !== undefined)
      body.response_format = opts.responseFormat;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new HttpException(
        `LLM 上游返回 ${res.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    const parsed = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content === '') {
      throw new HttpException('LLM 上游没有返回内容', HttpStatus.BAD_GATEWAY);
    }
    return content;
  }
}
