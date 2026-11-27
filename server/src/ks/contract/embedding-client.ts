export interface EmbeddingQueryClient {
  readonly model?: string;
  embedQuery(text: string, timeoutMs?: number): Promise<number[]>;
}

export const EMBEDDING_QUERY_CLIENT = Symbol('EMBEDDING_QUERY_CLIENT');
