-- FAQ 逐张审核（owner 2026-10-31：员工要能审核整张 FAQ 表）。
-- 每次审核一行（只追加）：审的是哪一版（faq_version）、结论（没问题 / 要改）、备注、谁、何时。
-- 卡的审核状态 = 当前版本上最近的一次审核；卡改过（version 变了）就回到「未审核」，所以不在 helpdesk_faqs 上加列。
CREATE TABLE "helpdesk_faq_reviews" (
    "id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "faq_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "employee_id" UUID,
    "idempotency_key" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_reviews_status_check" CHECK ("status" IN ('ok', 'needs_change')),
    CONSTRAINT "helpdesk_faq_reviews_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500),
    CONSTRAINT "helpdesk_faq_reviews_faq_fkey" FOREIGN KEY ("faq_id") REFERENCES "helpdesk_faqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "helpdesk_faq_reviews_idempotency_key_key" ON "helpdesk_faq_reviews"("idempotency_key");
CREATE INDEX "helpdesk_faq_reviews_faq_idx" ON "helpdesk_faq_reviews"("faq_id", "faq_version", "at");

CREATE TRIGGER "helpdesk_faq_reviews_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_reviews"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();
