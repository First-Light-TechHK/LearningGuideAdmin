-- Optimistic concurrency for the course draft (PRD 23 "updated by someone else, please refresh").
ALTER TABLE "CommerceCourse" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CommerceCourse" ADD COLUMN "revisionBy" UUID;
