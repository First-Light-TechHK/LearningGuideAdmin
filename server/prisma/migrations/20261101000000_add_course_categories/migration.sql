-- 课程分类补充（2026-11-01）：Category 除 Science 外，新增 Chinese Humanities / European Humanities。
-- 顶级分类（parentId 为 NULL）。幂等：已存在同名（不区分大小写）顶级分类则跳过；
-- 唯一索引 (parentId, name) 对 NULL parentId 不生效，故显式用 NOT EXISTS 判重。
INSERT INTO "CourseCatalogueEntry"
  (id, name, description, "parentId", status, "sortOrder", "updatedAt")
SELECT
  gen_random_uuid()::text,
  v.name,
  '',
  NULL,
  'ACTIVE'::"CatalogueStatus",
  (SELECT COALESCE(MAX("sortOrder"), 0) FROM "CourseCatalogueEntry" WHERE "parentId" IS NULL) + v.ord,
  now()
FROM (VALUES
  ('Chinese Humanities', 1),
  ('European Humanities', 2)
) AS v(name, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM "CourseCatalogueEntry" c
  WHERE c."parentId" IS NULL AND lower(c.name) = lower(v.name)
);
