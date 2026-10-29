-- 2026-10-26: Commerce Course 模块（v2）
-- 见 docs/Course_Module_Import_Export_Design.md §14。
-- 新增商品课程 v2 模型（课程→课时两层、多语言、展品、学习点、测试、试用、版本、媒体、运营位、导入导出作业），
-- 并给 KS Course 增加 commerceCourseId 关联列。所有内容表初始为空，可由课程包导入填充。

-- ===== 枚举 =====
CREATE TYPE "CourseLifecycleStatus" AS ENUM ('WORKING', 'IN_UAT', 'APPROVED', 'LIVE');
CREATE TYPE "CourseLiveStatus" AS ENUM ('ONLINE', 'HIDDEN', 'OFFLINE');
CREATE TYPE "LearningMode" AS ENUM ('VIDEO_ONLY', 'TEXT_ONLY', 'VIDEO_AND_TEXT');
CREATE TYPE "ExhibitType" AS ENUM ('IMAGE', 'VIDEO', 'MODEL3D');
CREATE TYPE "ReadingType" AS ENUM ('BOOK', 'ARTICLE', 'PAPER');
CREATE TYPE "TrialRowStatus" AS ENUM ('READY', 'RE_CONFIRM', 'LOCKED');
CREATE TYPE "LearningPointSource" AS ENUM ('VIDEO', 'TEXT');
CREATE TYPE "CourseMediaKind" AS ENUM ('IMAGE', 'VIDEO', 'PDF', 'AUDIO', 'MODEL3D');
CREATE TYPE "CatalogueStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CoursePackageJobKind" AS ENUM ('IMPORT', 'EXPORT');
CREATE TYPE "CoursePackageJobStatus" AS ENUM ('UPLOADING', 'VALIDATING', 'AWAITING_CONFIRM', 'IMPORTING', 'EXPORTING', 'READY', 'FAILED', 'CANCELLED');

-- ===== 分类目录 =====
CREATE TABLE "CourseCatalogueEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parentId" TEXT,
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CourseCatalogueEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CourseCatalogueEntry_parentId_name_key" ON "CourseCatalogueEntry"("parentId", "name");
CREATE INDEX "CourseCatalogueEntry_parentId_sortOrder_idx" ON "CourseCatalogueEntry"("parentId", "sortOrder");
ALTER TABLE "CourseCatalogueEntry" ADD CONSTRAINT "CourseCatalogueEntry_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "CourseCatalogueEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== 商品课程 =====
CREATE TABLE "CommerceCourse" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" TEXT,
    "subjectId" TEXT,
    "learningMode" "LearningMode" NOT NULL,
    "defaultContentLanguage" TEXT NOT NULL DEFAULT 'en-GB',
    "learningLanguages" JSONB NOT NULL,
    "coverAssetId" TEXT,
    "lifecycleStatus" "CourseLifecycleStatus" NOT NULL DEFAULT 'WORKING',
    "liveStatus" "CourseLiveStatus" NOT NULL DEFAULT 'HIDDEN',
    "liveVersionId" TEXT,
    "currentUatVersionId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "lastUatPublishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "subtitle" TEXT,
    "level" TEXT,
    "tags" JSONB,
    "referencePrice" INTEGER,
    "discount" INTEGER,
    "legacyCategory" TEXT,
    "legacyAuthorIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommerceCourse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommerceCourse_code_key" ON "CommerceCourse"("code");
CREATE UNIQUE INDEX "CommerceCourse_slug_key" ON "CommerceCourse"("slug");
CREATE UNIQUE INDEX "CommerceCourse_coverAssetId_key" ON "CommerceCourse"("coverAssetId");
CREATE INDEX "CommerceCourse_lifecycleStatus_updatedAt_idx" ON "CommerceCourse"("lifecycleStatus", "updatedAt");
CREATE INDEX "CommerceCourse_liveStatus_idx" ON "CommerceCourse"("liveStatus");
CREATE INDEX "CommerceCourse_categoryId_idx" ON "CommerceCourse"("categoryId");
ALTER TABLE "CommerceCourse" ADD CONSTRAINT "CommerceCourse_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "CourseCatalogueEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommerceCourse" ADD CONSTRAINT "CommerceCourse_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "CourseCatalogueEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== 课程多语言 =====
CREATE TABLE "CourseLocalization" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortDescription" TEXT,
    "overview" TEXT,
    "whatYouLearn" JSONB,
    "provides" JSONB,
    CONSTRAINT "CourseLocalization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CourseLocalization_courseId_language_key" ON "CourseLocalization"("courseId", "language");
ALTER TABLE "CourseLocalization" ADD CONSTRAINT "CourseLocalization_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 课时 =====
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "legacySectionId" TEXT,
    "legacySectionTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Lesson_courseId_code_key" ON "Lesson"("courseId", "code");
CREATE INDEX "Lesson_courseId_sortOrder_idx" ON "Lesson"("courseId", "sortOrder");
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LessonLocalization" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "videoAssetId" TEXT,
    "videoDurationSeconds" INTEGER,
    "textHtml" TEXT,
    "textLearningPoints" JSONB,
    "legacyContents" JSONB,
    CONSTRAINT "LessonLocalization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LessonLocalization_lessonId_language_key" ON "LessonLocalization"("lessonId", "language");
ALTER TABLE "LessonLocalization" ADD CONSTRAINT "LessonLocalization_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 展品 =====
CREATE TABLE "Exhibit" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ExhibitType" NOT NULL,
    "mediaAssetId" TEXT,
    "thumbnailAssetId" TEXT,
    "sourceText" TEXT,
    "localized" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Exhibit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Exhibit_lessonId_code_key" ON "Exhibit"("lessonId", "code");
ALTER TABLE "Exhibit" ADD CONSTRAINT "Exhibit_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 学习点 =====
CREATE TABLE "LearningPoint" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" "LearningPointSource" NOT NULL,
    "timeSeconds" INTEGER,
    "anchorHeading" TEXT,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "LearningPoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LearningPoint_lessonId_language_code_key" ON "LearningPoint"("lessonId", "language", "code");
ALTER TABLE "LearningPoint" ADD CONSTRAINT "LearningPoint_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExhibitTrigger" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "exhibitId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "timeSeconds" INTEGER NOT NULL,
    CONSTRAINT "ExhibitTrigger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExhibitTrigger_lessonId_exhibitId_language_key" ON "ExhibitTrigger"("lessonId", "exhibitId", "language");
ALTER TABLE "ExhibitTrigger" ADD CONSTRAINT "ExhibitTrigger_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 推荐阅读 =====
CREATE TABLE "RecommendedReading" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "type" "ReadingType" NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "whyRecommended" TEXT,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "RecommendedReading_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecommendedReading_lessonId_language_sortOrder_idx" ON "RecommendedReading"("lessonId", "language", "sortOrder");
ALTER TABLE "RecommendedReading" ADD CONSTRAINT "RecommendedReading_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 测试 =====
CREATE TABLE "KnowledgeQuestion" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "referenceAnswer" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "KnowledgeQuestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeQuestion_lessonId_code_key" ON "KnowledgeQuestion"("lessonId", "code");
ALTER TABLE "KnowledgeQuestion" ADD CONSTRAINT "KnowledgeQuestion_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApplicationTest" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "referenceAnswer" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ApplicationTest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApplicationTest_lessonId_key" ON "ApplicationTest"("lessonId");
ALTER TABLE "ApplicationTest" ADD CONSTRAINT "ApplicationTest_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 试用 =====
CREATE TABLE "TrialSetting" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "videoCutoffSeconds" INTEGER,
    "textCutoffLearningPointId" TEXT,
    "status" "TrialRowStatus" NOT NULL DEFAULT 'LOCKED',
    CONSTRAINT "TrialSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrialSetting_courseId_lessonId_key" ON "TrialSetting"("courseId", "lessonId");
ALTER TABLE "TrialSetting" ADD CONSTRAINT "TrialSetting_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 版本 =====
CREATE TABLE "CourseVersion" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "snapshotData" JSONB NOT NULL,
    "sourceVersionId" TEXT,
    "wentLiveAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CourseVersion_courseId_versionNo_key" ON "CourseVersion"("courseId", "versionNo");
CREATE INDEX "CourseVersion_courseId_wentLiveAt_idx" ON "CourseVersion"("courseId", "wentLiveAt");
ALTER TABLE "CourseVersion" ADD CONSTRAINT "CourseVersion_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 媒体 =====
CREATE TABLE "CourseMediaAsset" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "kind" "CourseMediaKind" NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseMediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CourseMediaAsset_storageKey_key" ON "CourseMediaAsset"("storageKey");
CREATE INDEX "CourseMediaAsset_courseId_kind_idx" ON "CourseMediaAsset"("courseId", "kind");
ALTER TABLE "CourseMediaAsset" ADD CONSTRAINT "CourseMediaAsset_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 课程封面 / 课时视频 / 展品媒体 外键（资产表已建）
ALTER TABLE "CommerceCourse" ADD CONSTRAINT "CommerceCourse_coverAssetId_fkey"
    FOREIGN KEY ("coverAssetId") REFERENCES "CourseMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LessonLocalization" ADD CONSTRAINT "LessonLocalization_videoAssetId_fkey"
    FOREIGN KEY ("videoAssetId") REFERENCES "CourseMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Exhibit" ADD CONSTRAINT "Exhibit_mediaAssetId_fkey"
    FOREIGN KEY ("mediaAssetId") REFERENCES "CourseMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Exhibit" ADD CONSTRAINT "Exhibit_thumbnailAssetId_fkey"
    FOREIGN KEY ("thumbnailAssetId") REFERENCES "CourseMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== plans（预留） =====
CREATE TABLE "CoursePlan" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "device" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeLookupKey" TEXT,
    "aiPoints" INTEGER NOT NULL DEFAULT 0,
    "trialEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoursePlan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CoursePlan_scope_scopeId_idx" ON "CoursePlan"("scope", "scopeId");
ALTER TABLE "CoursePlan" ADD CONSTRAINT "CoursePlan_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== 作者 =====
CREATE TABLE "CommerceCourseAuthor" (
    "courseId" TEXT NOT NULL,
    "employeeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommerceCourseAuthor_pkey" PRIMARY KEY ("courseId", "employeeId")
);
CREATE INDEX "CommerceCourseAuthor_employeeId_idx" ON "CommerceCourseAuthor"("employeeId");
ALTER TABLE "CommerceCourseAuthor" ADD CONSTRAINT "CommerceCourseAuthor_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== 课程审计 =====
CREATE TABLE "CourseAuthoringActivity" (
    "id" BIGSERIAL NOT NULL,
    "courseId" TEXT,
    "actorEmployeeId" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseAuthoringActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CourseAuthoringActivity_courseId_createdAt_idx" ON "CourseAuthoringActivity"("courseId", "createdAt" DESC);

-- ===== 运营位 =====
CREATE TABLE "PopularCourseEntry" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PopularCourseEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PopularCourseEntry_courseId_key" ON "PopularCourseEntry"("courseId");
CREATE INDEX "PopularCourseEntry_sortOrder_idx" ON "PopularCourseEntry"("sortOrder");

CREATE TABLE "DiscoveryBanner" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "courseId" TEXT,
    "localized" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscoveryBanner_pkey" PRIMARY KEY ("id")
);

-- ===== 导入导出作业 =====
CREATE TABLE "CoursePackageJob" (
    "id" TEXT NOT NULL,
    "kind" "CoursePackageJobKind" NOT NULL,
    "status" "CoursePackageJobStatus" NOT NULL DEFAULT 'UPLOADING',
    "courseId" TEXT,
    "actorEmployeeId" UUID,
    "idempotencyKey" TEXT,
    "packageHash" TEXT,
    "sourceFileName" TEXT,
    "bytesTotal" INTEGER,
    "bytesReceived" INTEGER DEFAULT 0,
    "stage" TEXT,
    "progress" INTEGER DEFAULT 0,
    "manifest" JSONB,
    "report" JSONB,
    "conflicts" JSONB,
    "storageKey" TEXT,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "nextAttemptAt" TIMESTAMP(3),
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoursePackageJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoursePackageJob_idempotencyKey_key" ON "CoursePackageJob"("idempotencyKey");
CREATE INDEX "CoursePackageJob_kind_status_createdAt_idx" ON "CoursePackageJob"("kind", "status", "createdAt");
CREATE INDEX "CoursePackageJob_actorEmployeeId_createdAt_idx" ON "CoursePackageJob"("actorEmployeeId", "createdAt");

-- ===== KS Course 关联列 =====
ALTER TABLE "Course" ADD COLUMN "commerceCourseId" TEXT;
CREATE UNIQUE INDEX "Course_commerceCourseId_key" ON "Course"("commerceCourseId");
ALTER TABLE "Course" ADD CONSTRAINT "Course_commerceCourseId_fkey"
    FOREIGN KEY ("commerceCourseId") REFERENCES "CommerceCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
