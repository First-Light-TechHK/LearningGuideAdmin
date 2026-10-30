-- 2026-10-30: Course P1b（Draft → Publish → Version / History / Operations / Stripe）
-- 见 docs/Course_Management_PRD_v2_Aligned_Design.md §2–§12 与 docs/P1b_Implementation_Plan.md。
-- 调整点：草稿标记、版本编号与来源、导出标记、Stripe 同步字段、Lesson 软删除、
-- 试看复核基线、运营位发布状态、课程包来源版本。不改动既有业务表的数据语义。

-- ===== CommerceCourse：草稿与试看总开关 =====
ALTER TABLE "CommerceCourse"
    ADD COLUMN "hasDraft" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "draftSourceType" TEXT,
    ADD COLUMN "draftSourceEnvironment" TEXT,
    ADD COLUMN "draftSourceVersionLabel" TEXT,
    ADD COLUMN "trialEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ===== Lesson：软删除 =====
ALTER TABLE "Lesson" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- ===== TrialSetting：按语言截止点 + Re-confirm 基线 =====
ALTER TABLE "TrialSetting"
    ADD COLUMN "videoCutoffByLanguage" JSONB,
    ADD COLUMN "textCutoffByLanguage" JSONB,
    ADD COLUMN "confirmedVideoAssetId" TEXT,
    ADD COLUMN "confirmedTextCutoffCode" TEXT,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ===== CourseVersion：编号、来源、导出标记 =====
ALTER TABLE "CourseVersion"
    ADD COLUMN "versionLabel" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "versionSeries" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "versionMinor" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "sourceEnvironment" TEXT,
    ADD COLUMN "sourceVersionLabel" TEXT,
    ADD COLUMN "exportedAt" TIMESTAMP(3),
    ADD COLUMN "exportedBy" UUID;

-- 已有版本按 versionNo 回填一个可读编号，避免历史版本显示为空。
UPDATE "CourseVersion"
SET "versionMinor" = "versionNo",
    "versionLabel" = "versionNo"::text
WHERE "versionLabel" = '';

-- ===== CoursePlan：Stripe 产品/价格 =====
ALTER TABLE "CoursePlan"
    ADD COLUMN "stripeProductId" TEXT,
    ADD COLUMN "stripePriceId" TEXT,
    ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
    ADD COLUMN "syncError" TEXT,
    ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- ===== CourseAuthoringActivity：关联版本号 =====
ALTER TABLE "CourseAuthoringActivity" ADD COLUMN "versionNo" INTEGER;

-- ===== Operations：发布状态 =====
ALTER TABLE "DiscoveryBanner"
    ADD COLUMN "publishedAt" TIMESTAMP(3),
    ADD COLUMN "publishedBy" UUID;

CREATE TABLE "PopularCoursesState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "publishedAt" TIMESTAMP(3),
    "publishedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PopularCoursesState_pkey" PRIMARY KEY ("id")
);

-- ===== CoursePackageJob：导出源版本与文件标签 =====
ALTER TABLE "CoursePackageJob"
    ADD COLUMN "sourceVersionId" TEXT,
    ADD COLUMN "fileLabel" TEXT;
