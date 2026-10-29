import { Module } from '@nestjs/common';
import { EmbeddingService } from '../ai/embedding/embedding.service';
import { ChunkingService } from './chunking.service';
import { IndexingService } from './indexing.service';

/**
 * Knowledge 模块（RAG，2026-10-26 新增）。
 * 负责知识库的分块、索引构建。
 * 提供 EmbeddingService（给 KsModule 的 PrismaKnowledgeClient 做向量检索用）。
 */
@Module({
  providers: [EmbeddingService, ChunkingService, IndexingService],
  exports: [EmbeddingService, IndexingService],
})
export class KnowledgeModule {}
