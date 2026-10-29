-- Helpdesk FAQ（Tickets v2 Figma addendum §1，2026-10-29）：一条 FAQ 是一条中英双语记录
-- （Figma 1379:299 编辑抽屉），归 BackOffice（唯一写入方）；Portal 经
-- /api/integration/helpdesk/faqs 读已发布的。旧的 helpdesk_questions / helpdesk_question_revisions
-- 原样保留、不再使用、不搬数据（之后单独清理，见运维文档）。只加不改：已应用的迁移一个字不动。

-- CreateTable
CREATE TABLE "helpdesk_faqs" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "popular" BOOLEAN NOT NULL DEFAULT false,
    "question_en" TEXT NOT NULL,
    "answer_en" TEXT NOT NULL,
    "question_zh" TEXT NOT NULL,
    "answer_zh" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- 保存即发布（Figma 没有草稿）；删除 = 归档
    "status" TEXT NOT NULL DEFAULT 'published',
    -- 乐观并发：每次修改 WHERE id AND version，不一致即 409 VERSION_CONFLICT
    "version" INTEGER NOT NULL DEFAULT 1,
    -- 新建的 Idempotency-Key：同一个 key 重试只建一条
    "idempotency_key" UUID,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faqs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faqs_category_check"
        CHECK ("category" IN ('account_technical', 'courses_learning', 'payments_subscriptions', 'other')),
    CONSTRAINT "helpdesk_faqs_status_check" CHECK ("status" IN ('published', 'archived')),
    CONSTRAINT "helpdesk_faqs_question_en_check" CHECK (char_length("question_en") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faqs_answer_en_check" CHECK (char_length("answer_en") BETWEEN 1 AND 4000),
    CONSTRAINT "helpdesk_faqs_question_zh_check" CHECK (char_length("question_zh") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faqs_answer_zh_check" CHECK (char_length("answer_zh") BETWEEN 1 AND 4000),
    CONSTRAINT "helpdesk_faqs_keywords_check" CHECK (cardinality("keywords") <= 20),
    CONSTRAINT "helpdesk_faqs_version_check" CHECK ("version" >= 1)
);

-- CreateTable：只追加的修订记录（完整快照），与 FAQ 的修改在同一事务里写入
CREATE TABLE "helpdesk_faq_revisions" (
    "id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_revisions_action_check" CHECK ("action" IN ('create', 'update', 'archive'))
);

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_faqs_idempotency_key_key" ON "helpdesk_faqs"("idempotency_key");
CREATE INDEX "helpdesk_faqs_list_idx" ON "helpdesk_faqs"("status", "popular" DESC, "updated_at" DESC);
-- 英文候选检索：与 faqRepository.ts FAQ_CANDIDATES_SQL 的 to_tsvector 完全同一表达式，
-- 否则规划器用不上此索引（helpdesk-faqs-search-index.spec.ts 锁定）。中文走双字重叠，不建全文索引。
CREATE INDEX "helpdesk_faqs_search_en_idx" ON "helpdesk_faqs"
    USING GIN (to_tsvector('english', "question_en" || ' ' || "answer_en"));
CREATE INDEX "helpdesk_faqs_keywords_idx" ON "helpdesk_faqs" USING GIN ("keywords");
CREATE UNIQUE INDEX "helpdesk_faq_revisions_faq_version_key"
    ON "helpdesk_faq_revisions"("faq_id", "version");

-- AddForeignKey
ALTER TABLE "helpdesk_faq_revisions" ADD CONSTRAINT "helpdesk_faq_revisions_faq_id_fkey"
    FOREIGN KEY ("faq_id") REFERENCES "helpdesk_faqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 修订表只追加：拒绝 UPDATE / DELETE（FAQ 本身也不删除，只归档）
CREATE OR REPLACE FUNCTION helpdesk_faq_revisions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'helpdesk_faq_revisions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_revisions_append_only();

-- 推荐日志（§1 Suggestion log）：qa_id 的概念改名为 faq_id（新列，旧行不需要）；加来源；
-- 类型可空（chat / chip 没有工单类型）；结果加 chat 的 helpful / not_helpful（仍是首个为准）。
ALTER TABLE "helpdesk_suggestions" ADD COLUMN "faq_id" UUID;
ALTER TABLE "helpdesk_suggestions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'submit';
ALTER TABLE "helpdesk_suggestions" ALTER COLUMN "category" DROP NOT NULL;
ALTER TABLE "helpdesk_suggestions" ADD CONSTRAINT "helpdesk_suggestions_source_check"
    CHECK ("source" IN ('submit', 'chat', 'chip'));
ALTER TABLE "helpdesk_suggestions" DROP CONSTRAINT "helpdesk_suggestions_outcome_check";
ALTER TABLE "helpdesk_suggestions" ADD CONSTRAINT "helpdesk_suggestions_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('solved', 'declined', 'edited', 'helpful', 'not_helpful'));
CREATE INDEX "helpdesk_suggestions_faq_id_idx" ON "helpdesk_suggestions"("faq_id");
