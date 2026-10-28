-- Helpdesk 推荐日志（2026-10-28，Figma addendum §C）：归 Agent（agent 角色）写。
-- 每次检索一行；outcome 首个为准；query_text 只保留 90 天（之后清空，计数仍可用）。
-- qa_id 指向 BackOffice 的 helpdesk_questions，跨域不建外键。只加表。

-- CreateTable
CREATE TABLE "helpdesk_suggestions" (
    "id" UUID NOT NULL,
    "learner_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "query_text" TEXT,
    "candidate_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "qa_id" UUID,
    "model" TEXT,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_suggestions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_suggestions_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN ('solved', 'declined', 'edited'))
);

-- CreateIndex
CREATE INDEX "helpdesk_suggestions_qa_id_idx" ON "helpdesk_suggestions"("qa_id");
CREATE INDEX "helpdesk_suggestions_created_at_idx" ON "helpdesk_suggestions"("created_at");
