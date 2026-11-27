import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeUnavailableError } from '../../ks/contract/knowledge-client';

const DEFAULT_BATCH_SIZE = 20;
const RELEASE_REQUEST_TIMEOUT_MS = 30_000;
const QUERY_REQUEST_TIMEOUT_MS = 8_000;

class EmbeddingUpstreamError extends KnowledgeUnavailableError {
  constructor(readonly retryAfterMs: number) {
    super('向量检索上游暂不可用');
  }
}

function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = /^[a-z]/i.test(header) ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

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
  readonly model: string;
  private readonly batchSize: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('OPENROUTER_API_KEY') ?? '';
    this.baseUrl =
      this.config.get<string>('OPENROUTER_BASE_URL') ??
      'https://openrouter.ai/api/v1';
    this.model =
      this.config.get<string>('EMBEDDING_MODEL') ??
      'openai/text-embedding-3-small';
    const configuredBatchSize = this.config.get<string | number>(
      'EMBEDDING_BATCH_SIZE',
    );
    this.batchSize = Number(configuredBatchSize ?? DEFAULT_BATCH_SIZE);
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) {
      this.logger.warn(
        `EMBEDDING_BATCH_SIZE 必须为正整数，使用默认值 ${DEFAULT_BATCH_SIZE}`,
      );
      this.batchSize = DEFAULT_BATCH_SIZE;
    }
  }

  /**
   * 批量 embedding：将文本列表切成 batchSize 大小的批次，逐批调用 API。
   * 返回与输入等长的二维数组，每个元素是 1536 维向量。
   */
  async embedTexts(texts: string[], releaseId?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error('未配置 OPENROUTER_API_KEY，无法调用 embedding 服务');
    }

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const embeddings = await this.callEmbeddingApi(
        batch,
        i / this.batchSize + 1,
        releaseId,
      );
      results.push(...embeddings);
    }
    return results;
  }

  /** 单条查询 embedding（对话时检索用） */
  async embedQuery(text: string, timeoutMs?: number): Promise<number[]> {
    if (timeoutMs !== undefined) {
      if (!this.apiKey)
        throw new KnowledgeUnavailableError('缺少 embedding 配置');
      const [vector] = await this.requestEmbedding(
        [text],
        'qa-query',
        timeoutMs,
      );
      return vector;
    }
    const [embedding] = await this.embedTexts([text]);
    return embedding;
  }

  /**
   * 调用 OpenRouter embeddings 接口。
   * 错误仅落服务器日志，对外抛出通用错误（§9 安全）。
   */
  private async callEmbeddingApi(
    input: string[],
    batch: number,
    releaseId?: string,
  ): Promise<number[][]> {
    const context = releaseId
      ? `releaseId=${releaseId} batch=${batch}`
      : 'query';
    const timeoutMs = releaseId
      ? RELEASE_REQUEST_TIMEOUT_MS
      : QUERY_REQUEST_TIMEOUT_MS;
    // 版本构建可多等一会儿，在线检索需要尽快降级。
    let remainingWaitMs = releaseId ? 30_000 : 1_000;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestEmbedding(input, context, timeoutMs);
      } catch (error) {
        this.logger.warn(
          `Embedding ${context} attempt=${attempt} elapsedMs=${Date.now() - startedAt}`,
        );
        if (!(error instanceof KnowledgeUnavailableError) || attempt >= 3)
          throw error;
        const backoffMs = 250 * 2 ** (attempt - 1);
        const retryAfter =
          error instanceof EmbeddingUpstreamError ? error.retryAfterMs : 0;
        const requiredDelayMs = Math.max(backoffMs, retryAfter);
        if (requiredDelayMs > remainingWaitMs) {
          this.logger.warn(
            `Embedding ${context} retryDelayMs=${requiredDelayMs} exceeds remainingWaitMs=${remainingWaitMs}`,
          );
          throw error;
        }
        const jitterMs = Math.floor(Math.random() * (backoffMs / 4));
        const delayMs = Math.min(requiredDelayMs + jitterMs, remainingWaitMs);
        remainingWaitMs -= delayMs;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async requestEmbedding(
    input: string[],
    context: string,
    timeoutMs: number,
  ): Promise<number[][]> {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let phase = 'headers';
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
      });
      if (res.ok) {
        phase = 'body';
        const data = (await res.json()) as {
          data?: Array<{ embedding: number[] }>;
        };
        if (!data?.data || data.data.length !== input.length) {
          throw new Error('Embedding 返回数据长度不匹配');
        }
        return data.data.map((d) => d.embedding);
      }
    } catch (error) {
      if (
        signal.aborted ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError'))
      ) {
        this.logger.warn(
          `Embedding API 超时 ${context} phase=${phase} timeoutMs=${timeoutMs} inputs=${input.length}`,
        );
        throw new KnowledgeUnavailableError(`向量检索请求超时，阶段 ${phase}`);
      }
      if (phase === 'body') throw error;
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? cause.code
          : undefined;
      this.logger.warn(
        `Embedding API 连接失败 ${context} code=${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'unknown'}`,
      );
      throw new KnowledgeUnavailableError('向量检索无法连接');
    }

    this.logger.warn(`Embedding API status=${res.status} ${context}`);
    await res.body?.cancel().catch(() => undefined);
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      throw new EmbeddingUpstreamError(
        retryAfterMs(res.headers.get('Retry-After')),
      );
    }
    throw new Error(`Embedding 上游返回 ${res.status}`);
  }
}
