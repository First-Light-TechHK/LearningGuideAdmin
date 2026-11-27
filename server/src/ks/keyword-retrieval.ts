import type { RetrievedChunk } from './contract/knowledge-client';

export { retrievalTerms } from '../common/retrieval-terms';

/** 两路分数不可直接相加；用排名融合，避免短问题漏掉明确命中的课程术语。 */
export function mergeRetrievedChunks(
  semantic: RetrievedChunk[],
  lexical: RetrievedChunk[],
  topK: number,
): RetrievedChunk[] {
  const ranked = new Map<
    string,
    { chunk: RetrievedChunk; rankScore: number }
  >();
  for (const results of [lexical, semantic]) {
    const seen = new Set<string>();
    results.forEach((chunk, index) => {
      const key = JSON.stringify([
        chunk.pageTitle,
        chunk.heading,
        chunk.content,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      const entry = ranked.get(key) ?? { chunk, rankScore: 0 };
      if (chunk.score > entry.chunk.score) entry.chunk = chunk;
      entry.rankScore += 1 / (60 + index + 1);
      ranked.set(key, entry);
    });
  }
  return [...ranked.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, topK)
    .map((entry) => entry.chunk);
}
