-- 2026-10-26: RAG 知识库向量分块
-- 启用 pgvector 扩展，新增 KnowledgeChunk 表存储知识库向量分块。
-- Chunk 绑定 Release（不可变快照），删除 Release 时级联删除 chunks。

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "pageId" TEXT,
    "pageTitle" TEXT NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeChunk_releaseId_idx" ON "KnowledgeChunk"("releaseId");
CREATE INDEX "KnowledgeChunk_releaseId_sortOrder_idx" ON "KnowledgeChunk"("releaseId", "sortOrder");
-- HNSW 索引用于余弦相似度检索
CREATE INDEX "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_releaseId_fkey"
    FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
