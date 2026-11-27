CREATE TABLE "TutorTeachingCard" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "draft" JSONB NOT NULL,
  "approved" JSONB,
  "approvedRevision" INTEGER,
  "reviewerId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TutorTeachingCard_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TutorTeachingCard_courseId_fkey" FOREIGN KEY ("courseId")
    REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TutorTeachingCard_courseId_idx" ON "TutorTeachingCard"("courseId");
