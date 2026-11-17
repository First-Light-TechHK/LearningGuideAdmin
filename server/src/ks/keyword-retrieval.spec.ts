import { mergeRetrievedChunks, retrievalTerms } from './keyword-retrieval';
import type { RetrievedChunk } from './contract/knowledge-client';

const chunk = (content: string, score = 0.2): RetrievedChunk => ({
  pageTitle: 'Course digest',
  heading: null,
  content,
  score,
  tokenCount: 100,
});

describe('课程关键词召回', () => {
  it.each([
    ['什么是积分？', ['积分']],
    ['请问，什么是“积分”？', ['积分']],
    ['What is an integral?', ['integral']],
    ['Please explain STATE variables.', ['state', 'variables']],
    ['积分、积分和导数', ['积分', '导数']],
    ['什么？ What is this?', []],
  ])('从 %s 中提取课程术语', (query, expected) => {
    expect(retrievalTerms(query)).toEqual(expected);
  });

  it('向量偏题时保留低余弦分数的关键词命中，不伪造相似度', () => {
    const integral = chunk('An integral accumulates small changes.');
    const vectors = chunk('Vector addition is component-wise.', 0.9);
    const result = mergeRetrievedChunks([vectors], [integral], 2);
    expect(result).toEqual([integral, vectors]);
    expect(result[0].score).toBe(0.2);
  });

  it('两路都命中的证据优先，重叠片段只返回一次并遵守 topK', () => {
    const shared = chunk('Both routes found this definition.');
    const lexical = chunk('Keyword match.');
    const semantic = chunk('Semantic match.');
    expect(
      mergeRetrievedChunks([semantic, shared], [lexical, shared], 2),
    ).toEqual([shared, lexical]);
    expect(mergeRetrievedChunks([], [], 6)).toEqual([]);
  });
});
