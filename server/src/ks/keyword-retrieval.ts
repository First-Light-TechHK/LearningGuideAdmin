import type { RetrievedChunk } from './contract/knowledge-client';

const STOP_WORDS = new Set(
  'what why how is are was were a an the of in on to do does can could you please explain define definition mean means this that course lesson tell me about and or 什么 什么是 什么叫 如何 为什么 请问 解释 介绍 一下 这个 那个 课程 本课程 本课 这门 这节 中的 意思'.split(
    ' ',
  ),
);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function retrievalTerms(query: string): string[] {
  const terms = Array.from(
    segmenter.segment(query.normalize('NFKC').toLowerCase()),
  )
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(terms)].slice(0, 12);
}

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
      entry.rankScore += 1 / (60 + index + 1);
      ranked.set(key, entry);
    });
  }
  return [...ranked.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, topK)
    .map((entry) => entry.chunk);
}
