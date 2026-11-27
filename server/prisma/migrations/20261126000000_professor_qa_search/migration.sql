CREATE TABLE "ProfessorQaIndex" (
  "releaseId" TEXT PRIMARY KEY REFERENCES "Release"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "activeGeneration" TEXT,
  lease TEXT,
  "nextAttempt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "ProfessorQaIndex_nextAttempt_idx" ON "ProfessorQaIndex" ("nextAttempt");

CREATE TABLE "ProfessorQaPart" (
  "releaseId" TEXT NOT NULL REFERENCES "ProfessorQaIndex"("releaseId") ON DELETE CASCADE ON UPDATE CASCADE,
  generation TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  part INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  terms tsvector NOT NULL,
  embedding vector(1536) NOT NULL,
  PRIMARY KEY ("releaseId", generation, "cardId", part)
);
CREATE INDEX "ProfessorQaPart_generation_contentHash_idx" ON "ProfessorQaPart" (generation, "contentHash");
CREATE INDEX "ProfessorQaPart_terms_idx" ON "ProfessorQaPart" USING gin (terms);

-- 和快照同事务登记，发布进程退出后仍能恢复构建。
CREATE FUNCTION enqueue_professor_qa_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ProfessorQaIndex" ("releaseId") VALUES (NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER enqueue_professor_qa_index AFTER INSERT ON "Release"
FOR EACH ROW WHEN (NEW."snapshotData"->'teachingPackage' IS NOT NULL)
EXECUTE FUNCTION enqueue_professor_qa_index();

INSERT INTO "ProfessorQaIndex" ("releaseId")
SELECT id FROM "Release" WHERE "snapshotData"->'teachingPackage' IS NOT NULL
ON CONFLICT DO NOTHING;
