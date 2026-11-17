import type { PrismaService } from '../prisma/prisma.service';
import { PrismaKnowledgeClient } from './prisma-knowledge.client';
import type { RetrievedChunk } from './contract/knowledge-client';

const evidence = (content: string, score: number): RetrievedChunk => ({
  pageTitle: 'Course digest',
  heading: 'Definitions',
  content,
  score,
  tokenCount: 100,
});

describe('KS 混合检索', () => {
  it('定义未进入向量候选时仍从同一 Release 召回关键词证据', async () => {
    const vectors = evidence('Vector addition.', 0.39);
    const integral = evidence('积分是把小块累积起来。', 0.2);
    const query = jest
      .fn()
      .mockResolvedValueOnce([vectors])
      .mockResolvedValueOnce([integral]);
    const embedQuery = jest.fn().mockResolvedValue([1, 0]);
    const client = new PrismaKnowledgeClient(
      { $queryRawUnsafe: query } as unknown as PrismaService,
      { embedQuery },
    );

    expect(await client.retrieveChunks('live-release', '什么是积分？')).toEqual(
      [integral, vectors],
    );
    expect(embedQuery).toHaveBeenCalledWith('什么是积分？');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE "releaseId" = $2'),
      '[1,0]',
      'live-release',
      ['积分'],
      6,
    );
  });

  it('无有效关键词时保留向量阈值和调用方指定的片段数', async () => {
    const relevant = evidence('Course evidence.', 0.8);
    const query = jest
      .fn()
      .mockResolvedValue([relevant, evidence('Irrelevant.', 0.1)]);
    const client = new PrismaKnowledgeClient(
      { $queryRawUnsafe: query } as unknown as PrismaService,
      { embedQuery: jest.fn().mockResolvedValue([1, 0]) },
    );
    expect(
      await client.retrieveChunks('another-release', '为什么？', 1),
    ).toEqual([relevant]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "releaseId" = $2'),
      '[1,0]',
      'another-release',
      1,
    );
  });

  it('空问题不查询；索引查询失败仍明确报错', async () => {
    const query = jest.fn().mockRejectedValue(new Error('KS unavailable'));
    const embedQuery = jest.fn().mockResolvedValue([1, 0]);
    const client = new PrismaKnowledgeClient(
      { $queryRawUnsafe: query } as unknown as PrismaService,
      { embedQuery },
    );
    expect(await client.retrieveChunks('r1', '  ')).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
    await expect(client.retrieveChunks('r1', '积分')).rejects.toThrow(
      'KS unavailable',
    );
  });
});
