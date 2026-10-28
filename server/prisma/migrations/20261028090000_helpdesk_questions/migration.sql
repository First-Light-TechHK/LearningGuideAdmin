-- Helpdesk Common Questions（2026-10-28，Figma addendum §A）：问答库归 BackOffice（唯一写入方），
-- Portal 只经 /api/integration/helpdesk/questions 读已发布的。只加表，不动已有数据；
-- 回滚到上一版代码时这两张表被忽略即可。

-- CreateTable
CREATE TABLE "helpdesk_questions" (
    "id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    -- 乐观并发：每次修改 WHERE id AND version，不一致即 409
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_questions_locale_check" CHECK ("locale" IN ('en-GB', 'zh-CN')),
    CONSTRAINT "helpdesk_questions_category_check"
        CHECK ("category" IN ('technical_support', 'course_content', 'payments_subscriptions', 'other')),
    CONSTRAINT "helpdesk_questions_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
    CONSTRAINT "helpdesk_questions_question_check" CHECK (char_length("question") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_questions_answer_check" CHECK (char_length("answer") BETWEEN 1 AND 4000),
    CONSTRAINT "helpdesk_questions_keywords_check" CHECK (cardinality("keywords") <= 20),
    CONSTRAINT "helpdesk_questions_version_check" CHECK ("version" >= 1)
);

-- CreateTable：只追加的修订记录，与问题的修改在同一事务里写入
CREATE TABLE "helpdesk_question_revisions" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_question_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_question_revisions_action_check"
        CHECK ("action" IN ('create', 'update', 'publish', 'unpublish', 'archive'))
);

-- CreateIndex
CREATE INDEX "helpdesk_questions_list_idx" ON "helpdesk_questions"("locale", "status", "sort_order");
-- 候选检索（Agent 推荐）：全文（simple 配置，不做词干）+ 关键词
CREATE INDEX "helpdesk_questions_search_idx" ON "helpdesk_questions"
    USING GIN (to_tsvector('simple', "question" || ' ' || "answer"));
CREATE INDEX "helpdesk_questions_keywords_idx" ON "helpdesk_questions" USING GIN ("keywords");
CREATE UNIQUE INDEX "helpdesk_question_revisions_question_version_key"
    ON "helpdesk_question_revisions"("question_id", "version");

-- AddForeignKey
ALTER TABLE "helpdesk_question_revisions" ADD CONSTRAINT "helpdesk_question_revisions_question_id_fkey"
    FOREIGN KEY ("question_id") REFERENCES "helpdesk_questions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 修订表只追加：拒绝 UPDATE / DELETE（问题本身也不删除，只归档）
CREATE OR REPLACE FUNCTION helpdesk_question_revisions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'helpdesk_question_revisions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_question_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_question_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_question_revisions_append_only();
