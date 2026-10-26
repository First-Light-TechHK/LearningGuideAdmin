import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
    this.batchSize =
      this.config.get<number>('EMBEDDING_BATCH_SIZE') ?? 100;
  }

  /**
   * 批量 embedding：将文本列表切成 batchSize 大小的批次，逐批调用 API。
   * 返回与输入等长的二维数组，每个元素是 1536 维向量。
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error(
        '未配置 OPENROUTER_API_KEY，无法调用 embedding 服务',
      );
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
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.warn(
        `Embedding API 返回 ${res.status}: ${errText.slice(0, 200)}`,
      );
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
