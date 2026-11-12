-- 课程分类补充（2026-11-12）：新增 Society（中文界面显示"社会"，见 client categoryLabel.ts）。
-- 顶级分类（parentId 为 NULL）。幂等：已存在同名（不区分大小写）顶级分类则跳过。
INSERT INTO "CourseCatalogueEntry"
  (id, name, description, "parentId", status, "sortOrder", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'Society',
  '',
  NULL,
  'ACTIVE'::"CatalogueStatus",
  (SELECT COALESCE(MAX("sortOrder"), 0) FROM "CourseCatalogueEntry" WHERE "parentId" IS NULL) + 1,
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "CourseCatalogueEntry" c
  WHERE c."parentId" IS NULL AND lower(c.name) = lower('Society')
);
