import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeUnavailableError } from '../../ks/contract/knowledge-client';

/**
 * Embedding 服务（RAG，2026-10-26 新增）。
 * 通过 OpenRouter 调用 OpenAI text-embedding-3-small，输出 1536 维向量。
 * 支持批量调用（每批 EMBEDDING_BATCH_SIZE 条），避免单次请求过大。
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly batchSize: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('OPENROUTER_API_KEY') ?? '';
    this.baseUrl =
      this.config.get<string>('OPENROUTER_BASE_URL') ??
      'https://openrouter.ai/api/v1';
    this.model =
      this.config.get<string>('EMBEDDING_MODEL') ??
      'openai/text-embedding-3-small';
    this.batchSize = this.config.get<number>('EMBEDDING_BATCH_SIZE') ?? 100;
  }

  /**
   * 批量 embedding：将文本列表切成 batchSize 大小的批次，逐批调用 API。
   * 返回与输入等长的二维数组，每个元素是 1536 维向量。
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error('未配置 OPENROUTER_API_KEY，无法调用 embedding 服务');
    }

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const embeddings = await this.callEmbeddingApi(batch);
      results.push(...embeddings);
    }
    return results;
  }

  /** 单条查询 embedding（对话时检索用） */
  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedTexts([text]);
    return embedding;
  }

  /**
   * 调用 OpenRouter embeddings 接口。
   * 错误仅落服务器日志，对外抛出通用错误（§9 安全）。
   */
  private async callEmbeddingApi(input: string[]): Promise<number[][]> {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestEmbedding(input);
      } catch (error) {
        const retry =
          error instanceof KnowledgeUnavailableError ||
          (error instanceof Error &&
            ['TimeoutError', 'AbortError'].includes(error.name));
        this.logger.warn(
          `Embedding attempt=${attempt} elapsedMs=${Date.now() - startedAt}`,
        );
        if (!retry || attempt >= 3) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** (attempt - 1)),
        );
      }
    }
  }

  private async requestEmbedding(input: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? cause.code
          : undefined;
      this.logger.warn(
        `Embedding API 连接失败 code=${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'unknown'}`,
      );
      throw new KnowledgeUnavailableError('向量检索无法连接');
    }

    if (!res.ok) {
      this.logger.warn(`Embedding API status=${res.status}`);
      await res.body?.cancel();
      if ([429, 500, 502, 503, 504].includes(res.status))
        throw new KnowledgeUnavailableError('向量检索上游暂不可用');
      throw new Error(`Embedding 上游返回 ${res.status}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
    };

    if (!data.data || data.data.length !== input.length) {
      throw new Error('Embedding 返回数据长度不匹配');
    }

    return data.data.map((d) => d.embedding);
  }
}
