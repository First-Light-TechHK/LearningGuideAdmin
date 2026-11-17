-- Legacy rows as they exist before 20261118010000_course_tests_trial: tests without a language,
-- per-lesson question codes, readings in a non-English language, a trial cut-off kept as a learning
-- point row id. Written for the schema AFTER 20261118000000_course_identity.

INSERT INTO "CommerceCourse" (id, code, slug, "learningMode", "learningLanguages", "updatedAt") VALUES
  ('mig-t', 'C010', 'mig-t', 'VIDEO_AND_TEXT', '["en-GB","zh-CN"]'::jsonb, now());

INSERT INTO "CourseMediaAsset" (id, "courseId", kind, "originalName", "mimeType", extension, size, "storageKey")
VALUES ('mig-t-video', 'mig-t', 'VIDEO', 'a.mp4', 'video/mp4', 'mp4', 1, 'mig-t/a.mp4');

-- L1 has a default-language row; L3 has questions but no localization row at all; L4 has nothing.
INSERT INTO "Lesson" (id, "courseId", code, "sortOrder", "updatedAt") VALUES
  ('mig-t-l1', 'mig-t', 'L1', 1, now()),
  ('mig-t-l3', 'mig-t', 'L3', 2, now()),
  ('mig-t-l4', 'mig-t', 'L4', 3, now());

INSERT INTO "LessonLocalization" (id, "lessonId", language, title) VALUES
  ('mig-t-ll1', 'mig-t-l1', 'en-GB', 'One'),
  ('mig-t-ll4', 'mig-t-l4', 'en-GB', 'Four');

-- Two lessons whose questions both start at K-0001 (the old per-lesson numbering).
INSERT INTO "KnowledgeQuestion" (id, "lessonId", code, question, "referenceAnswer", "sortOrder", enabled) VALUES
  ('mig-q11', 'mig-t-l1', 'K-0001', 'Q1.1', 'A', 1, true),
  ('mig-q12', 'mig-t-l1', 'K-0002', 'Q1.2', 'A', 2, true),
  ('mig-q31', 'mig-t-l3', 'K-0001', 'Q3.1', 'A', 1, true),
  ('mig-q32', 'mig-t-l3', 'K-0002', 'Q3.2', 'A', 2, true);

-- L1: an enabled application test. L3: a switched-off one.
INSERT INTO "ApplicationTest" (id, "lessonId", scenario, "referenceAnswer", enabled) VALUES
  ('mig-a1', 'mig-t-l1', 'Scenario 1', 'Answer', true),
  ('mig-a3', 'mig-t-l3', 'Scenario 3', 'Answer', false);

-- L1 has only Chinese readings; L3 has both languages.
INSERT INTO "RecommendedReading" (id, "lessonId", language, type, title, author, "whyRecommended", "sortOrder") VALUES
  ('mig-r1', 'mig-t-l1', 'zh-CN', 'BOOK', '书', '作者', '因为', 1),
  ('mig-r2', 'mig-t-l1', 'zh-CN', 'BOOK', '书二', '作者', '因为', 2),
  ('mig-r3', 'mig-t-l3', 'en-GB', 'BOOK', 'Book', 'Author', 'Because', 1),
  ('mig-r4', 'mig-t-l3', 'zh-CN', 'BOOK', '书', '作者', '因为', 1);

INSERT INTO "LearningPoint" (id, "lessonId", language, code, title, source, "timeSeconds", "sortOrder") VALUES
  ('mig-lp-t1', 'mig-t-l1', 'en-GB', 'T1', 'One', 'TEXT', NULL, 1),
  ('mig-lp-t2', 'mig-t-l1', 'en-GB', 'T2', 'Two', 'TEXT', NULL, 2),
  ('mig-lp-tz', 'mig-t-l1', 'zh-CN', 'T1', '一', 'TEXT', NULL, 1);

-- Trial: the last trial lesson L1 keeps its cut-offs as ids; a second row has a plain code.
INSERT INTO "TrialSetting" (id, "courseId", "lessonId", "videoCutoffSeconds", "textCutoffLearningPointId",
                            "videoCutoffByLanguage", "textCutoffByLanguage",
                            "confirmedVideoAssetId", "confirmedTextCutoffCode", status, "updatedAt")
VALUES
  ('mig-trial-1', 'mig-t', 'mig-t-l1', 60, 'mig-lp-t2', '{"zh-CN": 90}', '{"zh-CN": "mig-lp-tz"}',
   'mig-t-video', 'T2', 'READY', now()),
  ('mig-trial-2', 'mig-t', 'mig-t-l3', NULL, 'T3', NULL, NULL, NULL, NULL, 'READY', now());
