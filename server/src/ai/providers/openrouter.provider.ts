import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
  LlmTimeoutError,
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
    for await (const event of this.streamEvents(opts)) {
      if (event.type === 'delta') yield event.content;
      else opts.onEvent?.(event);
    }
  }

  async *streamEvents(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent> {
    if (
      (opts.temperature !== undefined && !Number.isFinite(opts.temperature)) ||
      (opts.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(opts.maxOutputTokens) ||
          opts.maxOutputTokens < 1)) ||
      (opts.timeoutMs !== undefined &&
        (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1))
    )
      throw new TypeError('invalid LLM stream options');
    const timeoutSignal = opts.timeoutMs
      ? AbortSignal.timeout(opts.timeoutMs)
      : undefined;
    const signal =
      opts.signal && timeoutSignal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : (opts.signal ?? timeoutSignal);
    const body = {
      model: opts.model,
      messages: opts.messages satisfies LlmMessage[],
      stream: true,
      usage: { include: true },
      ...(opts.temperature === undefined
        ? {}
        : { temperature: opts.temperature }),
      ...(opts.maxOutputTokens === undefined
        ? {}
        : { max_tokens: opts.maxOutputTokens }),
      ...(opts.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: opts.reasoningEffort } }),
    };
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (timeoutSignal?.aborted && !opts.signal?.aborted)
        throw new LlmTimeoutError();
      throw error;
    }

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
    let finishReason: string | null = null;
    let finishEmitted = false;

    try {
      while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          if (timeoutSignal?.aborted && !opts.signal?.aborted)
            throw new LlmTimeoutError();
          throw error;
        }
        const { done, value } = read;
        if (done) {
          buffer += decoder.decode();
          if (!buffer.trim()) break;
          buffer += '\n';
        } else {
          buffer += decoder.decode(value, { stream: true });
        }
        // 按行解析 SSE：仅消费完整行，残段留在 buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            yield { type: 'finish', reason: finishReason };
            finishEmitted = true;
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
              error?: unknown;
              usage?: {
                prompt_tokens?: unknown;
                completion_tokens?: unknown;
                completion_tokens_details?: { reasoning_tokens?: unknown };
              };
              choices?: Array<{
                error?: unknown;
                delta?: { content?: string };
                finish_reason?: unknown;
              }>;
            };
            if (
              parsed.error ||
              parsed.choices?.some(
                (choice) =>
                  choice.error ||
                  choice.finish_reason === 'error' ||
                  choice.finish_reason === 'content_filter',
              )
            ) {
              throw new HttpException(
                'LLM 上游生成失败',
                HttpStatus.BAD_GATEWAY,
              );
            }
            const usage = parsed.usage;
            if (
              usage &&
              (usage.prompt_tokens !== undefined ||
                usage.completion_tokens !== undefined)
            ) {
              const inputTokens = usage.prompt_tokens;
              const outputTokens = usage.completion_tokens;
              const reasoningTokens =
                usage.completion_tokens_details?.reasoning_tokens;
              if (
                (inputTokens === undefined ||
                  (Number.isSafeInteger(inputTokens) &&
                    (inputTokens as number) >= 0)) &&
                (outputTokens === undefined ||
                  (Number.isSafeInteger(outputTokens) &&
                    (outputTokens as number) >= 0)) &&
                (reasoningTokens === undefined ||
                  (Number.isSafeInteger(reasoningTokens) &&
                    (reasoningTokens as number) >= 0))
              ) {
                yield {
                  type: 'usage',
                  usage: {
                    ...(inputTokens === undefined
                      ? {}
                      : { inputTokens: inputTokens as number }),
                    ...(outputTokens === undefined
                      ? {}
                      : { outputTokens: outputTokens as number }),
                    ...(reasoningTokens === undefined
                      ? {}
                      : { reasoningTokens: reasoningTokens as number }),
                  },
                };
              }
            }
            const choice = parsed.choices?.[0];
            if (typeof choice?.finish_reason === 'string')
              finishReason = choice.finish_reason;
            const delta = choice?.delta?.content;
            if (typeof delta === 'string' && delta)
              yield { type: 'delta', content: delta };
          } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new HttpException('LLM 上游生成失败', HttpStatus.BAD_GATEWAY);
          }
        }
        if (done) break;
      }
      if (!finishEmitted) {
        if (finishReason === null)
          throw new HttpException('LLM 上游连接中断', HttpStatus.BAD_GATEWAY);
        yield { type: 'finish', reason: finishReason };
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
