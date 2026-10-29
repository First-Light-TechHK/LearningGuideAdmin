import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
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
}
