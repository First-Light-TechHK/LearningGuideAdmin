-- 课程模块：测试按语言、试看按语言、英文推荐阅读（计划 B03 / 设计 D5、D6）。
--
--   1. KnowledgeQuestion：加 courseId、language；题目 ID 改成 Course 内唯一的 K-{课时号}{序号}；
--   2. ApplicationTest：加 courseId、language、code（A-{课时号}01）；唯一键从 lessonId 改成 (lessonId, language)；
--   3. LessonLocalization：每种 Content language 一个测试开关，按现有数据回填；
--   4. RecommendedReading：只有英文一份列表——没有英文行、只有别的语言行的课时，把这些行改标成 en-GB；
--   5. TrialSetting：cutoffs / confirmed 两列，从旧的按 id 的列回填。旧列保留，不再读取。
--
-- 本迁移明说的数据修正：题目编号重编、推荐阅读改标语言。
-- confirmed.textIndex 是该文本学习点在（课时、语言）里的位置，从 1 起。

-- 1. 知识题 ---------------------------------------------------------------------

ALTER TABLE "KnowledgeQuestion" ADD COLUMN "courseId" TEXT;
ALTER TABLE "KnowledgeQuestion" ADD COLUMN "language" TEXT;

-- 现有题目没有语言：归默认内容语言。
UPDATE "KnowledgeQuestion" q
SET "courseId" = l."courseId",
    "language" = c."defaultContentLanguage"
FROM "Lesson" l
JOIN "CommerceCourse" c ON c.id = l."courseId"
WHERE l.id = q."lessonId";

ALTER TABLE "KnowledgeQuestion" ALTER COLUMN "courseId" SET NOT NULL;
ALTER TABLE "KnowledgeQuestion" ALTER COLUMN "language" SET NOT NULL;

DROP INDEX "KnowledgeQuestion_lessonId_code_key";

-- 重编号：先全部改成临时编号，再按（课时、顺序）依次给 K-{LL}{QQ}；遇到已被占用的编号就顺延。
-- LL = 课时编号的结尾数字（没有数字用课时位置），QQ = 课时内的顺序；都至少两位。
UPDATE "KnowledgeQuestion" SET code = 'tmp-' || id;

DO $$
DECLARE
  q RECORD;
  lesson_number INTEGER;
  seq INTEGER;
  candidate TEXT;
  current_lesson TEXT := '';
BEGIN
  FOR q IN
    SELECT k.id, k."lessonId", k."courseId", l.code AS lesson_code, l."sortOrder" AS lesson_position
    FROM "KnowledgeQuestion" k
    JOIN "Lesson" l ON l.id = k."lessonId"
    ORDER BY k."courseId", l."sortOrder", l.code, k."lessonId", k."sortOrder", k.id
  LOOP
    IF q."lessonId" <> current_lesson THEN
      current_lesson := q."lessonId";
      seq := 0;
    END IF;
    lesson_number := COALESCE(
      NULLIF(substring(q.lesson_code FROM '([0-9]{1,9})$'), '')::int,
      q.lesson_position
    );
    LOOP
      seq := seq + 1;
      candidate := 'K-' || lpad(lesson_number::text, 2, '0') || lpad(seq::text, 2, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "KnowledgeQuestion" WHERE "courseId" = q."courseId" AND code = candidate
      );
    END LOOP;
    UPDATE "KnowledgeQuestion" SET code = candidate WHERE id = q.id;
    -- 下一个新题从 seq + 1 开始。
    INSERT INTO "CourseCodeCounter" ("key", "next")
    VALUES ('knowledge:' || q."lessonId", seq + 1)
    ON CONFLICT ("key") DO UPDATE SET "next" = GREATEST("CourseCodeCounter"."next", seq + 1);
  END LOOP;
END $$;

CREATE UNIQUE INDEX "KnowledgeQuestion_courseId_code_key" ON "KnowledgeQuestion"("courseId", "code");
CREATE INDEX "KnowledgeQuestion_lessonId_language_sortOrder_idx"
  ON "KnowledgeQuestion"("lessonId", "language", "sortOrder");
ALTER TABLE "KnowledgeQuestion"
  ADD CONSTRAINT "KnowledgeQuestion_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. 应用题 ---------------------------------------------------------------------

ALTER TABLE "ApplicationTest" ADD COLUMN "courseId" TEXT;
ALTER TABLE "ApplicationTest" ADD COLUMN "language" TEXT;
ALTER TABLE "ApplicationTest" ADD COLUMN "code" TEXT;

UPDATE "ApplicationTest" a
SET "courseId" = l."courseId",
    "language" = c."defaultContentLanguage"
FROM "Lesson" l
JOIN "CommerceCourse" c ON c.id = l."courseId"
WHERE l.id = a."lessonId";

DROP INDEX "ApplicationTest_lessonId_key";

DO $$
DECLARE
  a RECORD;
  lesson_number INTEGER;
  seq INTEGER;
  candidate TEXT;
BEGIN
  FOR a IN
    SELECT t.id, t."lessonId", t."courseId", l.code AS lesson_code, l."sortOrder" AS lesson_position
    FROM "ApplicationTest" t
    JOIN "Lesson" l ON l.id = t."lessonId"
    ORDER BY t."courseId", l."sortOrder", l.code, t.id
  LOOP
    lesson_number := COALESCE(
      NULLIF(substring(a.lesson_code FROM '([0-9]{1,9})$'), '')::int,
      a.lesson_position
    );
    seq := 0;
    LOOP
      seq := seq + 1;
      candidate := 'A-' || lpad(lesson_number::text, 2, '0') || lpad(seq::text, 2, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "ApplicationTest" WHERE "courseId" = a."courseId" AND code = candidate
      );
    END LOOP;
    UPDATE "ApplicationTest" SET code = candidate WHERE id = a.id;
    INSERT INTO "CourseCodeCounter" ("key", "next")
    VALUES ('application:' || a."lessonId", seq + 1)
    ON CONFLICT ("key") DO UPDATE SET "next" = GREATEST("CourseCodeCounter"."next", seq + 1);
  END LOOP;
END $$;

ALTER TABLE "ApplicationTest" ALTER COLUMN "courseId" SET NOT NULL;
ALTER TABLE "ApplicationTest" ALTER COLUMN "language" SET NOT NULL;
ALTER TABLE "ApplicationTest" ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX "ApplicationTest_lessonId_language_key" ON "ApplicationTest"("lessonId", "language");
CREATE UNIQUE INDEX "ApplicationTest_courseId_code_key" ON "ApplicationTest"("courseId", "code");
ALTER TABLE "ApplicationTest"
  ADD CONSTRAINT "ApplicationTest_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "CommerceCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. 测试开关 -------------------------------------------------------------------

ALTER TABLE "LessonLocalization"
  ADD COLUMN "knowledgeTestEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "applicationTestEnabled" BOOLEAN NOT NULL DEFAULT false;

-- 有题目或有应用题、但默认语言没有课时文本行的课时：补一行空字符串，开关才有地方存。
INSERT INTO "LessonLocalization" (id, "lessonId", language, title)
SELECT gen_random_uuid()::text, l.id, c."defaultContentLanguage", ''
FROM "Lesson" l
JOIN "CommerceCourse" c ON c.id = l."courseId"
WHERE (
    EXISTS (SELECT 1 FROM "KnowledgeQuestion" q WHERE q."lessonId" = l.id)
    OR EXISTS (SELECT 1 FROM "ApplicationTest" a WHERE a."lessonId" = l.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "LessonLocalization" ll
    WHERE ll."lessonId" = l.id AND ll.language = c."defaultContentLanguage"
  );

UPDATE "LessonLocalization" ll
SET "knowledgeTestEnabled" = EXISTS (
      SELECT 1 FROM "KnowledgeQuestion" q
      WHERE q."lessonId" = ll."lessonId" AND q.language = ll.language
    ),
    "applicationTestEnabled" = EXISTS (
      SELECT 1 FROM "ApplicationTest" a
      WHERE a."lessonId" = ll."lessonId" AND a.language = ll.language AND a.enabled
    );

-- 4. 推荐阅读（只有英文一份列表）-------------------------------------------------

DO $$
DECLARE
  moved INTEGER;
BEGIN
  UPDATE "RecommendedReading" r
  SET language = 'en-GB'
  WHERE r.language <> 'en-GB'
    AND NOT EXISTS (
      SELECT 1 FROM "RecommendedReading" e
      WHERE e."lessonId" = r."lessonId" AND e.language = 'en-GB'
    );
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'Recommended readings relabelled to en-GB: %', moved;
END $$;

-- 5. 试看 -----------------------------------------------------------------------

ALTER TABLE "TrialSetting" ADD COLUMN "cutoffs" JSONB;
ALTER TABLE "TrialSetting" ADD COLUMN "confirmed" JSONB;

DO $$
DECLARE
  t RECORD;
  lp RECORD;
  entry RECORD;
  default_lang TEXT;
  cut JSONB;
  conf JSONB;
  lang TEXT;
  resolved_code TEXT;
  pos INTEGER;
BEGIN
  FOR t IN
    SELECT ts.*, c."defaultContentLanguage" AS default_language
    FROM "TrialSetting" ts
    JOIN "CommerceCourse" c ON c.id = ts."courseId"
  LOOP
    default_lang := t.default_language;
    cut := '{}'::jsonb;
    conf := '{}'::jsonb;

    -- 视频截止秒数：每个语言的值；默认语言没有值时用旧的单值。
    IF t."videoCutoffByLanguage" IS NOT NULL AND jsonb_typeof(t."videoCutoffByLanguage") = 'object' THEN
      FOR entry IN SELECT key, value FROM jsonb_each(t."videoCutoffByLanguage") LOOP
        IF jsonb_typeof(entry.value) = 'number' THEN
          cut := jsonb_set(cut, ARRAY[entry.key],
            COALESCE(cut -> entry.key, '{}'::jsonb) || jsonb_build_object('videoSeconds', entry.value));
        END IF;
      END LOOP;
    END IF;
    IF t."videoCutoffSeconds" IS NOT NULL AND NOT (cut ? default_lang) THEN
      cut := jsonb_set(cut, ARRAY[default_lang],
        COALESCE(cut -> default_lang, '{}'::jsonb) || jsonb_build_object('videoSeconds', t."videoCutoffSeconds"));
    END IF;

    -- 文本截止点：每个语言的学习点 id → 该学习点的编号；本来就是编号的值原样保留。
    IF t."textCutoffByLanguage" IS NOT NULL AND jsonb_typeof(t."textCutoffByLanguage") = 'object' THEN
      FOR entry IN SELECT key, value FROM jsonb_each(t."textCutoffByLanguage") LOOP
        IF jsonb_typeof(entry.value) = 'string' THEN
          SELECT code INTO resolved_code FROM "LearningPoint"
          WHERE id = (entry.value #>> '{}');
          resolved_code := COALESCE(resolved_code, entry.value #>> '{}');
          cut := jsonb_set(cut, ARRAY[entry.key],
            COALESCE(cut -> entry.key, '{}'::jsonb) || jsonb_build_object('textLpCode', resolved_code));
        END IF;
      END LOOP;
    END IF;
    IF t."textCutoffLearningPointId" IS NOT NULL THEN
      SELECT id, code, language INTO lp FROM "LearningPoint" WHERE id = t."textCutoffLearningPointId";
      IF FOUND THEN
        IF NOT (COALESCE(cut -> lp.language, '{}'::jsonb) ? 'textLpCode') THEN
          cut := jsonb_set(cut, ARRAY[lp.language],
            COALESCE(cut -> lp.language, '{}'::jsonb) || jsonb_build_object('textLpCode', lp.code));
        END IF;
      ELSIF NOT (COALESCE(cut -> default_lang, '{}'::jsonb) ? 'textLpCode') THEN
        -- 已经是编号的值，归默认语言。
        cut := jsonb_set(cut, ARRAY[default_lang],
          COALESCE(cut -> default_lang, '{}'::jsonb) || jsonb_build_object('textLpCode', t."textCutoffLearningPointId"));
      END IF;
    END IF;

    -- Re-confirm 基线：视频文件归默认语言；文本截止点的编号及其当时的位置。
    IF t."confirmedVideoAssetId" IS NOT NULL THEN
      conf := jsonb_set(conf, ARRAY[default_lang],
        COALESCE(conf -> default_lang, '{}'::jsonb) || jsonb_build_object('videoAssetId', t."confirmedVideoAssetId"));
    END IF;
    IF t."confirmedTextCutoffCode" IS NOT NULL THEN
      SELECT language INTO lang FROM "LearningPoint"
      WHERE "lessonId" = t."lessonId" AND source = 'TEXT' AND code = t."confirmedTextCutoffCode"
      ORDER BY (language = default_lang) DESC, language
      LIMIT 1;
      lang := COALESCE(lang, default_lang);
      SELECT count(*) INTO pos FROM "LearningPoint" p
      WHERE p."lessonId" = t."lessonId" AND p.source = 'TEXT' AND p.language = lang
        AND (p."sortOrder", p.code) <= (
          SELECT p2."sortOrder", p2.code FROM "LearningPoint" p2
          WHERE p2."lessonId" = t."lessonId" AND p2.source = 'TEXT' AND p2.language = lang
            AND p2.code = t."confirmedTextCutoffCode"
        );
      conf := jsonb_set(conf, ARRAY[lang],
        COALESCE(conf -> lang, '{}'::jsonb)
        || jsonb_build_object('textLpCode', t."confirmedTextCutoffCode",
                              'textIndex', CASE WHEN pos > 0 THEN pos ELSE NULL END));
    END IF;

    UPDATE "TrialSetting"
    SET cutoffs = CASE WHEN cut = '{}'::jsonb THEN NULL ELSE cut END,
        confirmed = CASE WHEN conf = '{}'::jsonb THEN NULL ELSE conf END
    WHERE id = t.id;
  END LOOP;
END $$;
