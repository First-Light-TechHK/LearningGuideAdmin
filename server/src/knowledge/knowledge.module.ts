import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChunkingService } from './chunking.service';
import { IndexingService } from './indexing.service';
import { RetrievalService } from './retrieval.service';

/**
 * Knowledge 模块（RAG，2026-10-26 新增）。
 * 负责知识库的分块、索引构建与向量检索。
 * 依赖 AiModule 导出的 EmbeddingService。
 */
@Module({
  imports: [AiModule],
  providers: [ChunkingService, IndexingService, RetrievalService],
  exports: [IndexingService, RetrievalService],
})
export class KnowledgeModule {}
