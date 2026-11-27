import { Logger } from '@nestjs/common';
import type { EmbeddingService } from '../ai/embedding/embedding.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ChunkingService } from './chunking.service';
import { IndexingService } from './indexing.service';

describe('IndexingService', () => {
  afterEach(() => jest.restoreAllMocks());

  function setup(contentMd = 'Body') {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'r1' }]),
      $executeRawUnsafe: jest.fn(),
      knowledgeChunk: { deleteMany: jest.fn() },
    };
    const prisma = {
      release: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          snapshotData: {
            pages: [{ id: 'p1', title: 'L1', contentMd }],
          },
        }),
      },
      $transaction: jest.fn((run: (client: typeof tx) => Promise<void>) =>
        run(tx),
      ),
    };
    const embedding = { embedTexts: jest.fn() };
    const indexing = new IndexingService(
      prisma as unknown as PrismaService,
      new ChunkingService(),
      embedding as unknown as EmbeddingService,
    );
    return { indexing, prisma, tx, embedding };
  }

  it('deduplicates builds and allows retry after an embedding failure without deleting existing chunks', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { indexing, prisma, tx, embedding } = setup();
    embedding.embedTexts
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([[1]]);

    expect(indexing.status('r1', 0)).toBe('missing');
    const build = indexing.indexRelease('r1');
    expect(indexing.status('r1', 0)).toBe('building');
    expect(indexing.indexRelease('r1')).toBe(build);
    await build;
    expect(indexing.status('r1', 12)).toBe('failed');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(embedding.embedTexts).toHaveBeenCalledWith(['Body'], 'r1');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('releaseId=r1 stage=embedding'),
    );

    await indexing.indexRelease('r1');
    expect(embedding.embedTexts).toHaveBeenCalledTimes(2);
    expect(tx.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { releaseId: 'r1' },
    });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(indexing.status('r1', 1)).toBe('ready');
  });

  it('logs the chunking stage when the version has no indexable text', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { indexing, embedding } = setup(' ');

    await indexing.indexRelease('r1');

    expect(indexing.status('r1', 0)).toBe('failed');
    expect(embedding.embedTexts).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('releaseId=r1 stage=chunking'),
    );
  });

  it('logs the failed database batch', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const content = Array.from(
      { length: 21 },
      (_, i) => `# Section ${i + 1}\nBody`,
    ).join('\n');
    const { indexing, tx, embedding } = setup(content);
    embedding.embedTexts.mockResolvedValue(
      Array.from({ length: 21 }, () => [1]),
    );
    tx.$executeRawUnsafe
      .mockResolvedValueOnce(20)
      .mockRejectedValueOnce(new Error('write failed'));

    await indexing.indexRelease('r1');

    expect(indexing.status('r1', 12)).toBe('failed');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('releaseId=r1 stage=database batch=2'),
    );
  });
});
