CREATE TABLE "KnowledgeImageAsset" (
    "id" UUID NOT NULL,
    "courseId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeImageAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeImageAsset_storageKey_key" ON "KnowledgeImageAsset"("storageKey");
CREATE INDEX "KnowledgeImageAsset_createdAt_idx" ON "KnowledgeImageAsset"("createdAt");
CREATE INDEX "KnowledgeImageAsset_courseId_idx" ON "KnowledgeImageAsset"("courseId");