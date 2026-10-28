/**
 * e2e 用的假 EmbeddingService：发布后的索引构建与对话检索都不走真实上游，
 * 没有 OpenRouter key 的 CI 也能跑通对话用例（RAG 2026-10-26 引入后需要）。
 */
const DIMENSIONS = 1536;

const vector = (): number[] => Array.from({ length: DIMENSIONS }, () => 0.01);

export const fakeEmbeddingService = {
  embedTexts: (texts: string[]): Promise<number[][]> =>
    Promise.resolve(texts.map(() => vector())),
  embedQuery: (): Promise<number[]> => Promise.resolve(vector()),
};
