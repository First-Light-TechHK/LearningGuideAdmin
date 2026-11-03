import { HttpException } from '@nestjs/common';
import type { Response } from 'express';

/**
 * 将文本增量流写成 SSE（§4.4.1）。
 * 先消费首增量：限流/校验/配置类错误在响应头发出前抛出，仍由全局过滤器
 * 输出标准错误信封；流中途失败则下发 error 帧后结束。
 */
export async function pipeSse(
  gen: AsyncGenerator<string>,
  res: Response,
): Promise<void> {
  const first = await gen.next();

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    if (!first.done) write({ delta: first.value });
    for await (const delta of gen) write({ delta });
    write({ done: true });
  } catch (err) {
    write({
      error:
        err instanceof HttpException
          ? err.message
          : 'AI 服务暂时不可用，请稍后重试',
    });
  } finally {
    res.end();
  }
}

/** Cancel upstream model work when the client closes the response. */
export async function pipeSseWithAbort(
  createGenerator: (signal: AbortSignal) => AsyncGenerator<string>,
  res: Response,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    await pipeSse(createGenerator(controller.signal), res);
  } finally {
    res.off('close', abort);
  }
}
