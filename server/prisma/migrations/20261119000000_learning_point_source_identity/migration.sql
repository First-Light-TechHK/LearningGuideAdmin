-- DropIndex
DROP INDEX "LearningPoint_lessonId_language_code_key";

-- CreateIndex
CREATE UNIQUE INDEX "LearningPoint_lessonId_language_source_code_key" ON "LearningPoint"("lessonId", "language", "source", "code");
