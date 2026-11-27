BEGIN;
ALTER TABLE "TutorTeachingCard"
  ADD COLUMN "createdAt" TIMESTAMP(3),
  ADD COLUMN "additionPosition" INTEGER NOT NULL DEFAULT 0;

-- Unedited entries still have their original timestamp. Freeze the previous
-- list order for the others without assigning them fictitious creation dates.
WITH prior AS (
  SELECT id, row_number() OVER (PARTITION BY "courseId" ORDER BY "updatedAt" DESC, id) AS position
  FROM "TutorTeachingCard"
)
UPDATE "TutorTeachingCard" AS card
SET "createdAt" = CASE WHEN card.revision = 1 THEN card."updatedAt" END,
    "additionPosition" = prior.position
FROM prior WHERE prior.id = card.id;

ALTER TABLE "TutorTeachingCard" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
COMMIT;
