-- Helpdesk FAQ 修改记录（BackOffice Change Log，Figma 草案 2.6–2.9）：学员问法的增删也要留痕。
-- 问法表是硬删的，所以单独记一行（谁、何时、加了 / 删了哪一条），与改动同一事务；只追加。
-- FAQ 本身（helpdesk_faq_revisions）与边（helpdesk_faq_edge_revisions）已经有修订表。

CREATE TABLE "helpdesk_faq_phrasing_revisions" (
    "id" UUID NOT NULL,
    "phrasing_id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_phrasing_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_phrasing_revisions_action_check" CHECK ("action" IN ('create', 'delete'))
);

CREATE INDEX "helpdesk_faq_phrasing_revisions_faq_idx" ON "helpdesk_faq_phrasing_revisions"("faq_id", "at");
CREATE INDEX "helpdesk_faq_phrasing_revisions_at_idx" ON "helpdesk_faq_phrasing_revisions"("at");

CREATE TRIGGER "helpdesk_faq_phrasing_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_phrasing_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();

-- 已有的问法补一行「加上」，时间与执行人取自问法本身，日志从第一天起是完整的
INSERT INTO "helpdesk_faq_phrasing_revisions"
    ("id", "phrasing_id", "faq_id", "action", "locale", "text", "source", "employee_id", "at")
SELECT gen_random_uuid(), p."id", p."faq_id", 'create', p."locale", p."text", p."source", p."created_by", p."created_at"
  FROM "helpdesk_faq_phrasings" p;

-- 修订表按时间倒序翻页（Change Log 按时间排）
CREATE INDEX "helpdesk_faq_revisions_at_idx" ON "helpdesk_faq_revisions"("at");
CREATE INDEX "helpdesk_faq_edge_revisions_at_idx" ON "helpdesk_faq_edge_revisions"("at");
-- 一条 FAQ 的修改记录也看它作为子节点被连上 / 移除
CREATE INDEX "helpdesk_faq_edge_revisions_child_idx" ON "helpdesk_faq_edge_revisions"("child_id", "at");
