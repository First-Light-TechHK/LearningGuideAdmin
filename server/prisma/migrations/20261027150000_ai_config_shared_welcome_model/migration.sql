-- 2026-10-27 AI 配置结构调整（需求：Welcome / Model 课程级统一，新增 Assessment 模式）
-- 变更：
--   ① CourseAiConfig 新增 assessmentSystemPrompt（Assessment 模式 System Prompt）
--   ② 新增 assessmentModeId（Assessment 模式绑定的模板，外键 → PromptTemplate）
--   ③ 新增 welcomeMsg（课程级统一欢迎语，替代 lectureWelcomeMsg / socraticWelcomeMsg）
--   ④ 新增 model（课程级统一 LLM 模型，替代 lectureModel / socraticModel）
--   ⑤ 存量回填：welcomeMsg 取 lectureWelcomeMsg（兜底 socraticWelcomeMsg），model 取 lectureModel（兜底 socraticModel）
--   ⑥ 删除 lectureWelcomeMsg / socraticWelcomeMsg / lectureModel / socraticModel

-- 1) 新增列
ALTER TABLE "CourseAiConfig" ADD COLUMN "assessmentSystemPrompt" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN "assessmentModeId" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN "welcomeMsg" TEXT;
ALTER TABLE "CourseAiConfig" ADD COLUMN "model" TEXT;

-- 2) 存量回填（Lecture 优先，Socratic 兜底）
UPDATE "CourseAiConfig"
SET "welcomeMsg" = COALESCE("lectureWelcomeMsg", "socraticWelcomeMsg"),
    "model"      = COALESCE("lectureModel", "socraticModel");

-- 3) 删除旧的按模式分列
ALTER TABLE "CourseAiConfig" DROP COLUMN "lectureWelcomeMsg";
ALTER TABLE "CourseAiConfig" DROP COLUMN "socraticWelcomeMsg";
ALTER TABLE "CourseAiConfig" DROP COLUMN "lectureModel";
ALTER TABLE "CourseAiConfig" DROP COLUMN "socraticModel";

-- 4) Assessment 模式外键
ALTER TABLE "CourseAiConfig"
  ADD CONSTRAINT "CourseAiConfig_assessmentModeId_fkey"
  FOREIGN KEY ("assessmentModeId") REFERENCES "PromptTemplate"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
