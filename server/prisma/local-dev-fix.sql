-- Local-dev only: satisfy pending migrations without pgvector.
-- Applied manually then recorded via `prisma migrate resolve --applied`.

-- 1) add_knowledge_chunk (pgvector not available locally -> text placeholder, no hnsw)
CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "pageId" TEXT,
    "pageTitle" TEXT NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_releaseId_idx" ON "KnowledgeChunk"("releaseId");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_releaseId_sortOrder_idx" ON "KnowledgeChunk"("releaseId", "sortOrder");
DO $$ BEGIN
  ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_releaseId_fkey"
    FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) ai_config_shared_welcome_model
ALTER TABLE "CourseAiConfig" ADD COLUMN IF NOT EXISTS "assessmentSystemPrompt" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN IF NOT EXISTS "assessmentModeId" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN IF NOT EXISTS "welcomeMsg" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN IF NOT EXISTS "model" TEXT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='CourseAiConfig' AND column_name='lectureWelcomeMsg') THEN
    UPDATE "CourseAiConfig"
      SET "welcomeMsg" = COALESCE("lectureWelcomeMsg", "socraticWelcomeMsg"),
          "model" = COALESCE("lectureModel", "socraticModel");
  END IF;
END $$;
ALTER TABLE "CourseAiConfig" DROP COLUMN IF EXISTS "lectureWelcomeMsg";
ALTER TABLE "CourseAiConfig" DROP COLUMN IF EXISTS "socraticWelcomeMsg";
ALTER TABLE "CourseAiConfig" DROP COLUMN IF EXISTS "lectureModel";
ALTER TABLE "CourseAiConfig" DROP COLUMN IF EXISTS "socraticModel";
DO $$ BEGIN
  ALTER TABLE "CourseAiConfig" ADD CONSTRAINT "CourseAiConfig_assessmentModeId_fkey"
    FOREIGN KEY ("assessmentModeId") REFERENCES "PromptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
