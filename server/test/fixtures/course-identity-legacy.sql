-- Legacy course rows as they exist before 20261118000000_course_identity: no Exhibit.courseId,
-- codes allocated by hand, a lesson gap, raw-import exhibit codes repeated across lessons, a trigger
-- that points at an exhibit which is gone. Written for the OLD schema.

INSERT INTO "CommerceCourse" (id, code, slug, "learningMode", "learningLanguages", "updatedAt") VALUES
  ('mig-a', 'C007', 'mig-a', 'VIDEO_AND_TEXT', '["en-GB","zh-CN"]'::jsonb, now()),
  ('mig-b', 'LEGACY-MODELING', 'mig-b', 'VIDEO_AND_TEXT', '["en-GB"]'::jsonb, now()),
  ('mig-c', 'C002', 'mig-c', 'VIDEO_AND_TEXT', '["en-GB"]'::jsonb, now());

INSERT INTO "CourseMediaAsset" (id, "courseId", kind, "originalName", "mimeType", extension, size, "storageKey") VALUES
  ('mig-v-en', 'mig-a', 'VIDEO', 'a.mp4', 'video/mp4', 'mp4', 1, 'mig/a.mp4'),
  ('mig-img', 'mig-a', 'IMAGE', 'a.png', 'image/png', 'png', 1, 'mig/a.png');

-- Course A: L1 and L3 active (a gap at 2), L5 archived. Course C: two lessons with equal sortOrder.
INSERT INTO "Lesson" (id, "courseId", code, "sortOrder", "archivedAt", "createdAt", "updatedAt") VALUES
  ('mig-la', 'mig-a', 'L1', 1, NULL, '2026-01-01', now()),
  ('mig-lb', 'mig-a', 'L3', 3, NULL, '2026-01-02', now()),
  ('mig-lz', 'mig-a', 'L5', 5, '2026-03-01', '2026-01-03', now()),
  ('mig-lc1', 'mig-c', 'L001', 1, NULL, '2026-01-01', now()),
  ('mig-lc2', 'mig-c', 'L002', 1, NULL, '2026-01-02', now());

INSERT INTO "LessonLocalization" (id, "lessonId", language, title, "videoAssetId", "videoDurationSeconds", "textHtml") VALUES
  ('mig-ll-a-en', 'mig-la', 'en-GB', 'A', 'mig-v-en', 100,
   '<h1>One</h1><figure data-exhibit-code="E001" data-exhibit-id="mig-ea1" class="course-exhibit-card"></figure>'),
  ('mig-ll-b-en', 'mig-lb', 'en-GB', 'B', NULL, NULL,
   '<h1>Two</h1><figure data-exhibit-code="E001" data-exhibit-id="mig-eb1" class="course-exhibit-card"></figure><figure data-exhibit-code="E001" data-exhibit-id="mig-ea1"></figure>'),
  ('mig-ll-b-zh', 'mig-lb', 'zh-CN', 'B', NULL, NULL,
   '<h1>二</h1><figure data-exhibit-code="E001" data-exhibit-id="mig-eb1"></figure>');

-- Exhibits: E001 and E002 in lesson A; the raw importer repeated E001 in lesson B.
INSERT INTO "Exhibit" (id, "lessonId", code, type, localized, "createdAt", "updatedAt") VALUES
  ('mig-ea2', 'mig-la', 'E002', 'IMAGE', '{}', '2026-01-05', now()),
  ('mig-ea1', 'mig-la', 'E001', 'IMAGE', '{}', '2026-01-04', now()),
  ('mig-eb1', 'mig-lb', 'E001', 'IMAGE', '{}', '2026-02-01', now());

-- Triggers: a good one, one pointing at an exhibit that does not exist, one at another lesson's exhibit.
INSERT INTO "ExhibitTrigger" (id, "lessonId", "exhibitId", language, "timeSeconds") VALUES
  ('tg-good', 'mig-la', 'mig-ea1', 'en-GB', 25),
  ('tg-orphan', 'mig-la', 'E9-gone', 'en-GB', 10),
  ('tg-foreign', 'mig-la', 'mig-eb1', 'zh-CN', 30),
  ('tg-b', 'mig-lb', 'mig-eb1', 'en-GB', 5);

-- Learning points with legacy codes (1.3 counts as 3).
INSERT INTO "LearningPoint" (id, "lessonId", language, code, title, source, "timeSeconds", "sortOrder") VALUES
  ('lp-v1', 'mig-la', 'en-GB', '1.1', 'V1', 'VIDEO', 10, 1),
  ('lp-v3', 'mig-la', 'en-GB', '1.3', 'V3', 'VIDEO', 70, 2),
  ('lp-vz', 'mig-la', 'zh-CN', 'V1', 'Z1', 'VIDEO', 5, 1),
  ('lp-t1', 'mig-la', 'en-GB', 'T1', 'One', 'TEXT', NULL, 1),
  ('lp-t2', 'mig-la', 'en-GB', 'T2', 'Two', 'TEXT', NULL, 2);
