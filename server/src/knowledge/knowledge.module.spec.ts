import { Test } from '@nestjs/testing';
import { EmbeddingService } from '../ai/embedding/embedding.service';
import { EMBEDDING_QUERY_CLIENT } from '../ks/contract/embedding-client';
import { PrismaKnowledgeClient } from '../ks/prisma-knowledge.client';
import { PrismaService } from '../prisma/prisma.service';
import { ChunkingService } from './chunking.service';
import { IndexingService } from './indexing.service';
import { KnowledgeModule } from './knowledge.module';

describe('KnowledgeModule embedding port', () => {
  it('exports the existing embedding instance through the KS contract', async () => {
    const embedding = { embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]) };
    const module = await Test.createTestingModule({
      imports: [KnowledgeModule],
      providers: [
        PrismaKnowledgeClient,
        { provide: PrismaService, useValue: {} },
      ],
    })
      .overrideProvider(EmbeddingService)
      .useValue(embedding)
      .overrideProvider(ChunkingService)
      .useValue({})
      .overrideProvider(IndexingService)
      .useValue({})
      .compile();
    try {
      expect(module.get(EMBEDDING_QUERY_CLIENT)).toBe(embedding);
      expect(module.get(PrismaKnowledgeClient)).toBeInstanceOf(
        PrismaKnowledgeClient,
      );
    } finally {
      await module.close();
    }
  });
});
