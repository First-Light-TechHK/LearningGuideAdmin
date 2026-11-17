import { ConfigService } from '@nestjs/config';
import { KnowledgeUnavailableError } from '../../ks/contract/knowledge-client';
import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
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
  it('超时后最多尝试三次，且请求携带超时 signal', async () => {
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
  });
});
