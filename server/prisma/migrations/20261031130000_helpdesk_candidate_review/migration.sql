-- FAQ 候选审核（2026-10-31；owner：AI 只给建议，员工看详细信息和提问用户的状态后批准）：
-- - 建议多两种（Mem0 的「更新」与「删除」；「不动」= 驳回）：
--   update_faq = 已有卡过时或缺细节（提问像这张卡，当时给用户看的也就是它，仍没解决）；
--   retire_faq = 标记失效，即归档（不删除；旧的发布快照里还在）。
-- - accepted_place_id：接受时员工选的主位置（结构里的 step / deviation / cell）。位置本身写在
--   helpdesk_faq_placements（有它自己的只追加修订）；这里只记下这一次决定选了哪里，方便列表与审计。
--   不建外键：结构节点没卡挂着时可以删，删了这条记录仍然有效（同 helpdesk_faq_eval_cases.faq_id）。
-- 只加不改：已应用的迁移一个字不动。

ALTER TABLE "helpdesk_faq_candidates" DROP CONSTRAINT "helpdesk_faq_candidates_suggestion_check";
ALTER TABLE "helpdesk_faq_candidates" ADD CONSTRAINT "helpdesk_faq_candidates_suggestion_check"
    CHECK ("suggestion" IN ('new_faq', 'add_phrasing', 'follow_up', 'update_faq', 'retire_faq'));

ALTER TABLE "helpdesk_faq_candidates" DROP CONSTRAINT "helpdesk_faq_candidates_accepted_check";
ALTER TABLE "helpdesk_faq_candidates" ADD CONSTRAINT "helpdesk_faq_candidates_accepted_check"
    CHECK ("status" <> 'accepted' OR ("accepted_as" IN ('new_faq', 'add_phrasing', 'follow_up',
                                                         'update_faq', 'retire_faq')
                                      AND "accepted_faq_id" IS NOT NULL));

ALTER TABLE "helpdesk_faq_candidates" ADD COLUMN "accepted_place_id" UUID;
