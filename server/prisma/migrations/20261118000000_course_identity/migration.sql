-- 课程模块：编号与身份（计划 B02 / 设计 D1、D2）。只增不删（见下面三处明说的数据修正）。
--
--   1. CourseCodeCounter：所有给人看的编号的计数器，并按现有数据播种；
--   2. Exhibit.courseId + sortOrder：展品 ID 在 Course 内唯一（PRD L136），旧数据里跨课时重复的编号先改号；
--   3. ExhibitTrigger：展品与时间都可以先空着保存，同一展品可在多个时间点触发；
--   4. CourseMediaAsset：像素尺寸、时长、文件损坏标记；
--   5. 在用课时的 sortOrder 压成 1..N（保持原顺序）。
--
-- 本迁移明说的数据修正：重复的展品编号改号（保留最早的一条）、指向不存在展品的触发器清空展品、课时位置压紧。

-- 1. 计数器 ------------------------------------------------------------------

CREATE TABLE "CourseCodeCounter" (
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL,

    CONSTRAINT "CourseCodeCounter_pkey" PRIMARY KEY ("key")
);

-- Course ID：最大的 C<数字> + 1；不是 C+数字形式的旧编号保持原样，不参与计数。
INSERT INTO "CourseCodeCounter" ("key", "next")
SELECT 'course', max(substring(code FROM 2)::int) + 1
FROM "CommerceCourse"
WHERE code ~ '^C[0-9]{1,9}$'
HAVING count(*) > 0;

-- Lesson ID：每门课最大的结尾数字 + 1，已归档的课时也算（它们的编号永不再用）。
INSERT INTO "CourseCodeCounter" ("key", "next")
SELECT 'lesson:' || "courseId", max(substring(code FROM '([0-9]{1,9})$')::int) + 1
FROM "Lesson"
WHERE code ~ '[0-9]$'
GROUP BY "courseId";

-- Exhibit ID：每门课最大的 E<数字> + 1。
INSERT INTO "CourseCodeCounter" ("key", "next")
SELECT 'exhibit:' || l."courseId", max(substring(e.code FROM 2)::int) + 1
FROM "Exhibit" e
JOIN "Lesson" l ON l.id = e."lessonId"
WHERE e.code ~ '^E[0-9]{1,9}$'
GROUP BY l."courseId";

-- 学习点：每个（课时、语言、来源）最大的结尾数字 + 1；旧编号 1.3 按 3 计，V-1.2 按 2 计。
INSERT INTO "CourseCodeCounter" ("key", "next")
SELECT 'lp:' || "lessonId" || ':' || language || ':' || CASE source WHEN 'VIDEO' THEN 'V' ELSE 'T' END,
       max(substring(code FROM '([0-9]{1,9})$')::int) + 1
FROM "LearningPoint"
WHERE code ~ '[0-9]$'
GROUP BY "lessonId", language, source;

-- 2. 展品 ---------------------------------------------------------------------

ALTER TABLE "Exhibit" ADD COLUMN "courseId" TEXT;
ALTER TABLE "Exhibit" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

UPDATE "Exhibit" e
SET "courseId" = l."courseId"
FROM "Lesson" l
WHERE l.id = e."lessonId";

ALTER TABLE "Exhibit" ALTER COLUMN "courseId" SET NOT NULL;

-- 课时内的顺序：按创建时间、编号。
UPDATE "Exhibit" e
SET "sortOrder" = ranked.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY "lessonId" ORDER BY "createdAt", code, id) AS rn
  FROM "Exhibit"
) ranked
WHERE ranked.id = e.id;

-- 跨课时重复的编号（原始素材导入每个课时都从 E01 开始）：最早的一条保留，其余改成新编号，
-- 并把那一课时文本里这张卡片的编号一起改掉（卡片带 data-exhibit-id，不会误改别的课时）。
DO $$
DECLARE
  dup RECORD;
  new_number INTEGER;
  new_code TEXT;
BEGIN
  FOR dup IN
    SELECT id, "courseId", "lessonId", code, "createdAt"
    FROM (
      SELECT id, "courseId", "lessonId", code, "createdAt",
             row_number() OVER (PARTITION BY "courseId", code ORDER BY "createdAt", id) AS rn
      FROM "Exhibit"
    ) ranked
    WHERE rn > 1
    ORDER BY "courseId", "createdAt", id
  LOOP
    LOOP
      INSERT INTO "CourseCodeCounter" ("key", "next")
      VALUES ('exhibit:' || dup."courseId", 2)
      ON CONFLICT ("key") DO UPDATE SET "next" = "CourseCodeCounter"."next" + 1
      RETURNING "next" - 1 INTO new_number;
      new_code := 'E' || lpad(new_number::text, 3, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Exhibit" WHERE "courseId" = dup."courseId" AND code = new_code
      );
    END LOOP;

    UPDATE "Exhibit" SET code = new_code WHERE id = dup.id;
    UPDATE "LessonLocalization"
    SET "textHtml" = replace(
      "textHtml",
      'data-exhibit-code="' || dup.code || '" data-exhibit-id="' || dup.id || '"',
      'data-exhibit-code="' || new_code || '" data-exhibit-id="' || dup.id || '"'
    )
    WHERE "lessonId" = dup."lessonId" AND "textHtml" IS NOT NULL;
    RAISE NOTICE 'Exhibit % in lesson % renamed % -> %', dup.id, dup."lessonId", dup.code, new_code;
  END LOOP;
END $$;

ALTER TABLE "Exhibit"
  ADD CONSTRAINT "Exhibit_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Exhibit_courseId_code_key" ON "Exhibit"("courseId", "code");
CREATE INDEX "Exhibit_lessonId_sortOrder_idx" ON "Exhibit"("lessonId", "sortOrder");

-- 3. 展品触发器 ---------------------------------------------------------------

ALTER TABLE "ExhibitTrigger" ALTER COLUMN "exhibitId" DROP NOT NULL;
ALTER TABLE "ExhibitTrigger" ALTER COLUMN "timeSeconds" DROP NOT NULL;

-- 指向不存在的展品、或另一个课时的展品：清空（读作"还没选展品"，完整性规则会报告）。
UPDATE "ExhibitTrigger" t
SET "exhibitId" = NULL
WHERE t."exhibitId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Exhibit" e WHERE e.id = t."exhibitId" AND e."lessonId" = t."lessonId"
  );

DROP INDEX "ExhibitTrigger_lessonId_exhibitId_language_key";

ALTER TABLE "ExhibitTrigger" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
UPDATE "ExhibitTrigger" t
SET "sortOrder" = ranked.rn
FROM (
  SELECT id, row_number() OVER (
           PARTITION BY "lessonId", language ORDER BY "timeSeconds" NULLS LAST, id
         ) AS rn
  FROM "ExhibitTrigger"
) ranked
WHERE ranked.id = t.id;

ALTER TABLE "ExhibitTrigger"
  ADD CONSTRAINT "ExhibitTrigger_exhibitId_fkey"
  FOREIGN KEY ("exhibitId") REFERENCES "Exhibit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- 同一展品可在多个时间点触发；NULL 互不相同，未填完的行不会互相冲突。
CREATE UNIQUE INDEX "ExhibitTrigger_lessonId_language_exhibitId_timeSeconds_key"
  ON "ExhibitTrigger"("lessonId", "language", "exhibitId", "timeSeconds");

-- 4. 媒体文件元数据 -----------------------------------------------------------

ALTER TABLE "CourseMediaAsset"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "durationSeconds" INTEGER,
  ADD COLUMN "brokenAt" TIMESTAMP(3),
  ADD COLUMN "brokenReason" TEXT;

-- 课时视频的时长原先只存在课时上：回填到文件上（同一文件被多处使用时取最大值）。
UPDATE "CourseMediaAsset" a
SET "durationSeconds" = d.seconds
FROM (
  SELECT "videoAssetId" AS asset_id, max("videoDurationSeconds") AS seconds
  FROM "LessonLocalization"
  WHERE "videoAssetId" IS NOT NULL AND "videoDurationSeconds" IS NOT NULL
  GROUP BY "videoAssetId"
) d
WHERE d.asset_id = a.id AND a.kind = 'VIDEO';

-- 5. 课时位置压紧 -------------------------------------------------------------

-- 在用课时按原顺序压成 1..N（删除、整理顺序留下的空洞和重复值）；已归档课时不动。
UPDATE "Lesson" l
SET "sortOrder" = ranked.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY "courseId" ORDER BY "sortOrder", "createdAt", id) AS rn
  FROM "Lesson"
  WHERE "archivedAt" IS NULL
) ranked
WHERE ranked.id = l.id AND l."sortOrder" <> ranked.rn;
