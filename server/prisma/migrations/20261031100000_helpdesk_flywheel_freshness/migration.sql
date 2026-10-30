-- Helpdesk v5 Part G（数据飞轮的复核修正，2026-10-31）。只加不改（20261031090000 一个字不动）：
-- - helpdesk_insight_turns.checked_at：最近一次从 Portal 拉到这一轮的时间（内容没变也更新）。
--   「答案落定」改为 checked_at ≥ created_at + 24 小时：只有答案之后至少 24 小时的一次拉取看到
--   「没有工单」才算 AI 解决；拉取晚了或失败了，AI 解决率不会虚高。已有的行按 updated_at 保守地填。
-- - helpdesk_insight_turns.redacted_at：员工以「含个人信息」驳回候选时，候选的成员轮的文字与客服回复
--   被清掉并记下时间；之后再拉到同一轮，文字也不会回来。
-- - helpdesk_faq_candidate_revisions.employee_name：动作当时员工的显示名（历史里显示是谁）。
-- - 视图 helpdesk_insight_turn_facts 重建（列多了 checked_at、redacted_at；落定的判定如上）。
-- - 还没落定的工单结果的部分索引：每晚往回补拉的起点从它查。

ALTER TABLE "helpdesk_insight_turns" ADD COLUMN "checked_at" TIMESTAMPTZ(6);
UPDATE "helpdesk_insight_turns" SET "checked_at" = "updated_at";
ALTER TABLE "helpdesk_insight_turns"
    ALTER COLUMN "checked_at" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "checked_at" SET NOT NULL;
ALTER TABLE "helpdesk_insight_turns" ADD COLUMN "redacted_at" TIMESTAMPTZ(6);

ALTER TABLE "helpdesk_faq_candidate_revisions" ADD COLUMN "employee_name" TEXT;
ALTER TABLE "helpdesk_faq_candidate_revisions" ADD CONSTRAINT "helpdesk_faq_candidate_revisions_employee_name_check"
    CHECK ("employee_name" IS NULL OR char_length("employee_name") <= 200);

CREATE INDEX "helpdesk_insight_turns_open_outcome_idx" ON "helpdesk_insight_turns"("created_at")
    WHERE "ticket_linked" IS NOT NULL AND "ticket_status" IS DISTINCT FROM 'CLOSED';

DROP VIEW "helpdesk_insight_turn_facts";

-- 每轮一行加上派生的判定。AI 解决 = 给了答案、24 小时内没有工单；只有答案之后至少 24 小时的一次拉取
-- （checked_at）才能判定。其余同 20261031090000。
CREATE VIEW "helpdesk_insight_turn_facts" AS
SELECT
    t.*,
    (t.created_at AT TIME ZONE 'UTC')::date AS "day",
    date_trunc('week', t.created_at AT TIME ZONE 'UTC')::date AS "week",
    COALESCE(t.source, 'unknown') AS "entry",
    (t.kind = 'answer') IS TRUE AS "is_answer",
    (t.kind = 'answer' AND t.checked_at >= t.created_at + interval '24 hours') IS TRUE AS "answer_settled",
    (t.kind = 'answer' AND t.checked_at >= t.created_at + interval '24 hours'
        AND NOT t.ticket_after_chat) IS TRUE AS "ai_solved",
    (t.kind = 'no_match') IS TRUE AS "is_no_match",
    (t.vote IN ('helpful', 'not_helpful', 'solved')) IS TRUE AS "voted",
    (t.vote IN ('helpful', 'solved')) IS TRUE AS "helpful",
    (t.kind = 'clarify') IS TRUE AS "is_clarify",
    (t.kind = 'clarify' AND t.covered) IS TRUE AS "clarify_covered",
    (t.guard IS NOT NULL) AS "guarded",
    (t.guard IS NOT NULL AND t.guard <> 'passed') AS "guard_fallback",
    (t.kind = 'no_match') IS TRUE AS "gap_no_match",
    (t.vote = 'not_helpful') IS TRUE AS "gap_not_helpful",
    (t.kind = 'clarify' AND t.covered IS FALSE) IS TRUE AS "gap_clarify_not_covered",
    t.handover AS "gap_handover",
    t.ticket_after_chat AS "gap_ticket_after_chat",
    (t.rating <= 2) IS TRUE AS "gap_low_rating",
    ((t.kind = 'no_match') IS TRUE OR (t.vote = 'not_helpful') IS TRUE
        OR (t.kind = 'clarify' AND t.covered IS FALSE) IS TRUE
        OR t.handover OR t.ticket_after_chat OR (t.rating <= 2) IS TRUE) AS "unsolved"
FROM "helpdesk_insight_turns" t;
