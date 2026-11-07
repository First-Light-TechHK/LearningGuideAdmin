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
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
