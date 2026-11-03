import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { pipeSseWithAbort } from './sse-stream';

function responseEmitter() {
  const emitter = new EventEmitter();
  const end = jest.fn();
  const response = Object.assign(emitter, {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    flushHeaders: jest.fn(),
    write: jest.fn().mockReturnValue(true),
    end,
  });
  return { emitter, response: response as unknown as Response, end };
}

describe('pipeSseWithAbort', () => {
  it('aborts upstream work when the client closes during first response wait', async () => {
    const { emitter, response, end } = responseEmitter();
    let signal: AbortSignal | undefined;
    const generator = (requestSignal: AbortSignal) => {
      signal = requestSignal;
      return (async function* () {
        await new Promise<void>((resolve) => {
          requestSignal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield 'cancelled';
      })();
    };
    setImmediate(() => emitter.emit('close'));

    await pipeSseWithAbort(generator, response);

    expect(signal?.aborted).toBe(true);
    expect(end.mock.calls).toHaveLength(1);
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('removes the close listener after a normal completion', async () => {
    const { emitter, response, end } = responseEmitter();
    await pipeSseWithAbort(async function* () {
      await Promise.resolve();
      yield 'done';
    }, response);
    expect(emitter.listenerCount('close')).toBe(0);
    expect(end.mock.calls).toHaveLength(1);
  });
});
