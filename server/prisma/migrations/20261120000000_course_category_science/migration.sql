-- 课程分类预置补全（2026-11-20，QA LOW-2）：补 Science 一级分类。
--
-- 产品要求：PRD v2.0 §9.1（docs/Course_Management_PRD_v2.0_CN.docx）规定 Category 必填、
-- "分类列表由开发预置"。
-- 预置一级分类的规范清单为（英文稳定键 + 中文显示名）：
--   Science（科学）/ Chinese Humanities（中国人文）/ European Humanities（欧洲人文）/ Society（社会）。
-- 来源：client/src/backoffice/lib/categoryLabel.ts 的规范名与中文映射；
-- 20261117000000_catalogue_single_source 的中文显示名预置表同样写的是这四个名字。
--
-- 现状：20261101000000_add_course_categories 的注释写明它在 Science 之外补两个
-- Humanities 分类，20261112030000_course_category_society 补 Society，但此前没有任何
-- 迁移或 seed 创建 Science：全新库 migrate deploy 后只有 3 个一级分类（QA LOW-2）。
--
-- 幂等：同名一级分类（trim、不区分大小写，含已归档）已存在则跳过，绝不修改用户已建分类。
-- sortOrder = 0：现有三个预置分类是 1/2/3，Science 按前端标签顺序排在预置分类首位。
INSERT INTO "CourseCatalogueEntry"
  (id, name, localized, description, "parentId", status, "sortOrder", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'Science',
  jsonb_build_object(
    'en-GB', jsonb_build_object('name', 'Science'),
    'zh-CN', jsonb_build_object('name', '科学')
  ),
  '',
  NULL,
  'ACTIVE'::"CatalogueStatus",
  0,
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM "CourseCatalogueEntry" c
  WHERE c."parentId" IS NULL
    AND lower(btrim(c.name)) = 'science'
);
