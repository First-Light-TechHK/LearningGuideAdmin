-- Content fingerprint of a published course version (sha256 of the canonical content view).
-- Nullable: versions published before this column are hashed on demand from their snapshot.
ALTER TABLE "CourseVersion" ADD COLUMN "contentHash" TEXT;
