import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeUnavailableError } from '../../ks/contract/knowledge-client';
import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each<[string | undefined, number[]]>([
    ['30', [30, 30, 30, 15]],
    [undefined, [20, 20, 20, 20, 20, 5]],
    ['0', [20, 20, 20, 20, 20, 5]],
    ['1.5', [20, 20, 20, 20, 20, 5]],
    ['invalid', [20, 20, 20, 20, 20, 5]],
  ])('批量大小 %s 在所有批次中生效', async (batchSize, expectedSizes) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const values: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: 'test',
      EMBEDDING_BATCH_SIZE: batchSize,
    };
    const config = { get: (key: string) => values[key] } as ConfigService;
    const sizes: number[] = [];
    globalThis.fetch = jest.fn(
      (_url: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string')
          throw new Error('Expected JSON body');
        const { input } = JSON.parse(init.body) as { input: string[] };
        sizes.push(input.length);
        const data = input.map((text) => ({ embedding: [Number(text)] }));
        return Promise.resolve(Response.json({ data }));
      },
    );
    const texts = Array.from({ length: 105 }, (_, index) => String(index));

    await expect(
      new EmbeddingService(config).embedTexts(texts),
    ).resolves.toEqual(texts.map((text) => [Number(text)]));
    expect(sizes).toEqual(expectedSizes);
  });

  it('向量接口连接失败时返回可识别的 503，不泄露 API Key', async () => {
    const key = 'test-key-local-only';
    const config = {
      get: (name: string) =>
        name === 'OPENROUTER_API_KEY'
          ? key
          : name === 'OPENROUTER_BASE_URL'
            ? 'https://example.invalid/api/v1'
            : undefined,
    } as ConfigService;
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed'));

    const request = new EmbeddingService(config).embedQuery('question');
    await expect(request).rejects.toBeInstanceOf(KnowledgeUnavailableError);
    await expect(request).rejects.toMatchObject({ status: 503 });
    await expect(request).rejects.not.toThrow(key);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 400])('HTTP %s 不重试', async (status) => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('', { status }));
    const service = new EmbeddingService({
      get: (name: string) =>
        name === 'OPENROUTER_API_KEY' ? 'test' : undefined,
    } as unknown as ConfigService);
    await expect(service.embedQuery('question')).rejects.toThrow(
      `Embedding 上游返回 ${status}`,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503, 0])('暂时故障 %s 后重试成功', async (status) => {
    const mock = jest.fn();
    if (status) mock.mockResolvedValueOnce(new Response('', { status }));
    else mock.mockRejectedValueOnce(new TypeError('fetch failed'));
    globalThis.fetch = mock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1] }] })),
    );
    const service = new EmbeddingService({
      get: (name: string) =>
        name === 'OPENROUTER_API_KEY' ? 'test' : undefined,
    } as unknown as ConfigService);
    await expect(service.embedQuery('question')).resolves.toEqual([1]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, number]>([
    ['2', 2031],
    ['Thu, 01 Jan 2026 00:00:02 GMT', 2031],
    ['30', 30_000],
  ])(
    '版本构建按 Retry-After %s 等待 %d ms 后重试',
    async (retryAfter, delayMs) => {
      jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': retryAfter },
          }),
        )
        .mockResolvedValueOnce(Response.json({ data: [{ embedding: [1] }] }));
      const service = new EmbeddingService(
        new ConfigService({ OPENROUTER_API_KEY: 'test' }),
      );

      const result = expect(
        service.embedTexts(['body'], 'r1'),
      ).resolves.toEqual([[1]]);
      await jest.advanceTimersByTimeAsync(delayMs - 1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await result;
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        'Embedding API status=429 releaseId=r1 batch=1',
      );
    },
  );

  it.each([
    [undefined, '2'],
    ['r1', '120'],
  ])(
    'Retry-After 超出等待预算时直接返回 503（版本 %s）',
    async (releaseId, retryAfter) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      globalThis.fetch = jest.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': retryAfter },
        }),
      );
      const service = new EmbeddingService(
        new ConfigService({ OPENROUTER_API_KEY: 'test' }),
      );
      const request = releaseId
        ? service.embedTexts(['body'], releaseId)
        : service.embedQuery('question');
      await expect(request).rejects.toBeInstanceOf(KnowledgeUnavailableError);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('版本构建以 30 秒为请求上限，读取响应体超时后重试', async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const stalled = new Response();
    jest
      .spyOn(stalled, 'json')
      .mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce(Response.json({ data: [{ embedding: [1] }] }));
    const service = new EmbeddingService(
      new ConfigService({ OPENROUTER_API_KEY: 'test' }),
    );

    const result = expect(service.embedTexts(['body'], 'r1')).resolves.toEqual([
      [1],
    ]);
    await jest.runAllTimersAsync();
    await result;

    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
    expect(warn).toHaveBeenCalledWith(
      'Embedding API 超时 releaseId=r1 batch=1 phase=body timeoutMs=30000 inputs=1',
    );
  });

  it('在线检索使用 8 秒超时，等待响应头超时最多尝试三次', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    globalThis.fetch = jest
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Promise.reject(new DOMException('timeout', 'TimeoutError'));
      });
    const service = new EmbeddingService({
      get: (name: string) =>
        name === 'OPENROUTER_API_KEY' ? 'test' : undefined,
    } as unknown as ConfigService);
    await expect(service.embedQuery('question')).rejects.toBeInstanceOf(
      KnowledgeUnavailableError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls).toEqual([[8000], [8000], [8000]]);
    expect(warn).toHaveBeenCalledWith(
      'Embedding API 超时 query phase=headers timeoutMs=8000 inputs=1',
    );
  });
});
