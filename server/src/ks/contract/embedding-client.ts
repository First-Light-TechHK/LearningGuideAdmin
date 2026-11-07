export interface EmbeddingQueryClient {
  embedQuery(text: string): Promise<number[]>;
}

export const EMBEDDING_QUERY_CLIENT = Symbol('EMBEDDING_QUERY_CLIENT');
