-- Helpdesk v5 Part A（2026-10-30）：FAQ 的学员情境信号标签。BackOffice 员工在 FAQ 编辑里多选，
-- Portal 读已发布 FAQ 时一起拿到（PublicFaq.signals，契约 fixture v6），按学员自己的情境（Portal 代码算，
-- 从不经过模型）挑「你可能遇到的问题」。open_ticket_waiting 不是 FAQ，不能打。
-- 只加不改：已应用的迁移一个字不动；旧行默认没有标签，旧的 Admin / Portal 不受影响。
ALTER TABLE "helpdesk_faqs"
    ADD COLUMN "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "helpdesk_faqs"
    ADD CONSTRAINT "helpdesk_faqs_signals_check" CHECK (
        "signals" <@ ARRAY['payment_failed', 'payment_pending', 'recent_purchase', 'trial_ending',
                           'subscription_expired', 'subscription_cancelled', 'email_unverified',
                           'from_order']::TEXT[]
        AND cardinality("signals") <= 8
    );
