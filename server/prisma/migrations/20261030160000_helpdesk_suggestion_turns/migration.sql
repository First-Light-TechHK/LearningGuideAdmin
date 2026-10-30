-- Helpdesk v5 Part B / D / H（2026-10-30）：聊天面板 v5 的一轮（请求带 context）在 helpdesk_suggestions 里
-- 多记 kind（answer / smalltalk / clarify / no_match）、intent、confidence、节点（回包的卡片，clarify 时是
-- 屏幕上那张）、摘录块、守卫结果（passed / fallback、原因码、回退的字段）、clarify 是否讲成、Portal 的会话 id
-- 与运行时读的发布版本。只有代码与枚举，从不记模型写的文字。
-- 只加不改：已应用的迁移一个字不动；旧行与旧请求的新列为 NULL / 空数组，旧的 Portal 不受影响。
ALTER TABLE "helpdesk_suggestions"
    ADD COLUMN "kind" TEXT,
    ADD COLUMN "intent" TEXT,
    ADD COLUMN "confidence" TEXT,
    ADD COLUMN "node_id" UUID,
    ADD COLUMN "blocks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "guard_result" TEXT,
    ADD COLUMN "guard_reason" TEXT,
    ADD COLUMN "guard_fallback" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "covered" BOOLEAN,
    ADD COLUMN "session_id" UUID,
    ADD COLUMN "release_version" INTEGER;

ALTER TABLE "helpdesk_suggestions"
    ADD CONSTRAINT "helpdesk_suggestions_kind_check"
        CHECK ("kind" IS NULL OR "kind" IN ('answer', 'smalltalk', 'clarify', 'no_match')),
    ADD CONSTRAINT "helpdesk_suggestions_intent_check"
        CHECK ("intent" IS NULL OR "intent" IN ('question', 'own_account', 'someone_else', 'exception',
                                                'private_data', 'instructions', 'off_topic', 'greeting',
                                                'farewell', 'vague', 'clarify')),
    ADD CONSTRAINT "helpdesk_suggestions_confidence_check"
        CHECK ("confidence" IS NULL OR "confidence" IN ('sure', 'unsure')),
    ADD CONSTRAINT "helpdesk_suggestions_blocks_check"
        CHECK (cardinality("blocks") <= 3),
    ADD CONSTRAINT "helpdesk_suggestions_guard_result_check"
        CHECK ("guard_result" IS NULL OR "guard_result" IN ('passed', 'fallback')),
    ADD CONSTRAINT "helpdesk_suggestions_guard_reason_check"
        CHECK ("guard_reason" IS NULL OR "guard_reason" IN ('missing', 'too_long', 'link', 'email', 'digit',
                                                            'markup', 'blocked_phrase', 'ai_filler', 'script',
                                                            'ungrounded', 'not_covered', 'timeout', 'error')),
    ADD CONSTRAINT "helpdesk_suggestions_guard_fallback_check"
        CHECK ("guard_fallback" <@ ARRAY['opening', 'closing', 'reply', 'explanation']::TEXT[]),
    ADD CONSTRAINT "helpdesk_suggestions_release_version_check"
        CHECK ("release_version" IS NULL OR "release_version" >= 1);

-- 一段对话（Portal 的 helpdesk_chat_sessions.id）的各轮
CREATE INDEX "helpdesk_suggestions_session_idx" ON "helpdesk_suggestions"("session_id")
    WHERE "session_id" IS NOT NULL;
