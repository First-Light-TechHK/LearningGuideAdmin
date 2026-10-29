-- DropIndex
DROP INDEX "KnowledgeChunk_embedding_idx";

-- AlterTable
ALTER TABLE "CourseAiConfig" ADD COLUMN     "mainSystemPrompt" TEXT;
