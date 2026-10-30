-- DropIndex
-- 本地/部分环境该索引可能已不存在：幂等处理，避免迁移在 DROP INDEX 处永久失败。
DROP INDEX IF EXISTS "KnowledgeChunk_embedding_idx";

-- AlterTable
ALTER TABLE "CourseAiConfig" ADD COLUMN     "mainSystemPrompt" TEXT;
