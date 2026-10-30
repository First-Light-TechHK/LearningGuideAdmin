-- Helpdesk v5 Part G3–G6（数据飞轮，2026-10-31）：
-- - helpdesk_insight_turns：Admin 的事实表。Admin 读不到 Portal 的库，数字只来自 Portal 的 insights
--   接口（契约 fixture v7：学员文字已被 Portal 的代码脱敏器处理，其余全是标签）。每晚按轮 id 幂等 upsert，
--   回看 72 小时让投票、评分与工单结果落定；这里从不存学员 id、姓名、邮箱、订单或工单号。
-- - helpdesk_insight_turn_facts：指标的 SQL 视图（AI 解决、no_match、有帮助、评分、转人工、clarify 讲成、
--   守卫回退、缺口原因），HelpDesk 数据页的每个数字都从它算，没有第二个数据源。
-- - helpdesk_faq_candidates（FAQ 候选）、helpdesk_faq_candidate_turns（哪一轮归哪个候选，一轮至多一个）、
--   helpdesk_faq_candidate_revisions（每次动作的审计，只追加）；
-- - helpdesk_faq_eval_cases：接受的候选的脱敏例句，按员工选的节点做发布评测门的回归用例；
-- - helpdesk_flywheel_runs：后台任务的运行行（每个任务每个 UTC 日至多一次定时运行；手动运行按
--   Idempotency-Key 幂等）。进程内调度，PostgreSQL advisory lock 保证多实例只跑一个。
-- 只加不改：已应用的迁移一个字不动；不建指向 helpdesk 以外表的外键。

-- ---------------------------------------------------------------------------
-- 1. 事实表
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_insight_turns" (
    -- Portal helpdesk_assist_log 的行 id
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT,
    "locale" TEXT NOT NULL,
    -- Portal 脱敏后的学员文字（占位符 <kind>）
    "text" TEXT NOT NULL,
    "session_id" UUID,
    "turn_index" SMALLINT,
    "last_turn" BOOLEAN,
    "session_end_reason" TEXT,
    "kind" TEXT,
    "intent" TEXT,
    "guard" TEXT,
    "via" TEXT,
    "faq_id" UUID,
    "node_id" UUID,
    "parent_node_id" UUID,
    "release_version" INTEGER,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "vote" TEXT,
    "rating" SMALLINT,
    "covered" BOOLEAN,
    "expanded" BOOLEAN,
    "handover" BOOLEAN NOT NULL DEFAULT false,
    "ticket_after_chat" BOOLEAN NOT NULL DEFAULT false,
    "ticket_linked" BOOLEAN,
    "ticket_status" TEXT,
    "ticket_close_reason" TEXT,
    "ticket_resolved_by_agent" BOOLEAN,
    "ticket_agent_replied" BOOLEAN,
    -- 客服解决时客服最后一条公开回复（Portal 已脱敏）；新 FAQ 唯一的草稿来源（草稿 待核实）
    "agent_reply" TEXT,
    "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_insight_turns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_insight_turns_text_check" CHECK (char_length("text") <= 500),
    CONSTRAINT "helpdesk_insight_turns_reply_check"
        CHECK ("agent_reply" IS NULL OR char_length("agent_reply") <= 2000),
    CONSTRAINT "helpdesk_insight_turns_rating_check"
        CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
    CONSTRAINT "helpdesk_insight_turns_kind_check"
        CHECK ("kind" IS NULL OR "kind" IN ('answer', 'smalltalk', 'clarify', 'no_match', 'handover')),
    CONSTRAINT "helpdesk_insight_turns_source_check"
        CHECK ("source" IS NULL OR "source" IN ('submit', 'chat', 'chip')),
    CONSTRAINT "helpdesk_insight_turns_vote_check"
        CHECK ("vote" IS NULL OR "vote" IN ('helpful', 'not_helpful', 'solved', 'declined', 'edited'))
);

CREATE INDEX "helpdesk_insight_turns_created_idx" ON "helpdesk_insight_turns"("created_at", "id");
CREATE INDEX "helpdesk_insight_turns_node_idx" ON "helpdesk_insight_turns"("node_id", "created_at");

-- ---------------------------------------------------------------------------
-- 2. 指标视图（v5 Part G6；全部从事实表算）
-- ---------------------------------------------------------------------------

-- 每轮一行加上派生的判定。AI 解决 = 给了答案、24 小时内没有工单（答案满 24 小时才判定）；
-- 有帮助率的分母是投了 helpful / not_helpful / solved 的；守卫回退率的分母是有守卫结果的轮；
-- unsolved 与 gap_* 是缺口挖掘（G3）选轮的同一套规则（flywheelMining.ts unsolvedReasons 用语料锁定一致）。
CREATE VIEW "helpdesk_insight_turn_facts" AS
SELECT
    t.*,
    (t.created_at AT TIME ZONE 'UTC')::date AS "day",
    date_trunc('week', t.created_at AT TIME ZONE 'UTC')::date AS "week",
    COALESCE(t.source, 'unknown') AS "entry",
    (t.kind = 'answer') IS TRUE AS "is_answer",
    (t.kind = 'answer' AND t.created_at <= now() - interval '24 hours') IS TRUE AS "answer_settled",
    (t.kind = 'answer' AND t.created_at <= now() - interval '24 hours'
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

-- ---------------------------------------------------------------------------
-- 3. FAQ 候选（G3 / G4）
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_candidates" (
    "id" UUID NOT NULL,
    -- new = 待处理；accepted = 已接受（新 FAQ / 加问法 / 加追问）；dismissed = 驳回（带原因）；merged = 并入另一个候选
    "status" TEXT NOT NULL DEFAULT 'new',
    -- 挖掘给的建议：new_faq / add_phrasing（加到 related_node_id）/ follow_up（挂到 parent_node_id 下）
    "suggestion" TEXT NOT NULL,
    -- mining = 夜间挖掘；ticket = 客服从已解决的工单「转成 FAQ 候选」
    "origin" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "proposed_question" TEXT NOT NULL,
    -- 话题与问题是谁写的：model（守卫过了）或 code（模型关着、超预算、失败或没过守卫）
    "label_source" TEXT NOT NULL,
    -- 模型给的分类（枚举）；没有为 NULL
    "category" TEXT,
    "locale" TEXT NOT NULL,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    -- 至多 5 个脱敏例句 [{ turnId, text, locale, reasons[] }]
    "examples" JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- 原因构成 { no_match, not_helpful, clarify_not_covered, handover, ticket_after_chat, low_rating, ticket }
    "source_mix" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 至多 3 条已解决工单里客服（人）的回复，已脱敏：「起草」只从这里来（草稿 待核实）
    "answer_sources" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "related_node_id" UUID,
    "related_score" REAL,
    "parent_node_id" UUID,
    -- 学员当时看到的（没帮上忙的）那张卡
    "shown_node_id" UUID,
    -- origin = ticket：Portal 的工单 id（同一张工单只转一次）
    "ticket_id" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "reason_note" TEXT,
    "accepted_as" TEXT,
    "accepted_faq_id" UUID,
    "merged_into" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    -- 最后一次动作的 Idempotency-Key（同一个 key 再来 = 原样返回）
    "action_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_candidates_status_check"
        CHECK ("status" IN ('new', 'accepted', 'dismissed', 'merged')),
    CONSTRAINT "helpdesk_faq_candidates_suggestion_check"
        CHECK ("suggestion" IN ('new_faq', 'add_phrasing', 'follow_up')),
    CONSTRAINT "helpdesk_faq_candidates_origin_check" CHECK ("origin" IN ('mining', 'ticket')),
    CONSTRAINT "helpdesk_faq_candidates_label_source_check" CHECK ("label_source" IN ('model', 'code')),
    CONSTRAINT "helpdesk_faq_candidates_category_check"
        CHECK ("category" IS NULL OR "category" IN ('account_technical', 'courses_learning',
                                                    'payments_subscriptions', 'other')),
    CONSTRAINT "helpdesk_faq_candidates_topic_check" CHECK (char_length("topic") BETWEEN 1 AND 80),
    CONSTRAINT "helpdesk_faq_candidates_question_check"
        CHECK (char_length("proposed_question") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_candidates_count_check" CHECK ("turn_count" >= 0),
    CONSTRAINT "helpdesk_faq_candidates_examples_check"
        CHECK (jsonb_typeof("examples") = 'array' AND jsonb_array_length("examples") <= 5),
    CONSTRAINT "helpdesk_faq_candidates_sources_check"
        CHECK (jsonb_typeof("answer_sources") = 'array' AND jsonb_array_length("answer_sources") <= 3),
    CONSTRAINT "helpdesk_faq_candidates_accepted_check"
        CHECK ("status" <> 'accepted' OR ("accepted_as" IN ('new_faq', 'add_phrasing', 'follow_up')
                                          AND "accepted_faq_id" IS NOT NULL)),
    CONSTRAINT "helpdesk_faq_candidates_dismissed_check"
        CHECK ("status" <> 'dismissed' OR "reason" IS NOT NULL),
    CONSTRAINT "helpdesk_faq_candidates_merged_check"
        CHECK ("status" <> 'merged' OR ("merged_into" IS NOT NULL AND "merged_into" <> "id"))
);

-- 队列：按条数排
CREATE INDEX "helpdesk_faq_candidates_queue_idx"
    ON "helpdesk_faq_candidates"("status", "turn_count" DESC, "last_seen_at" DESC, "id");
CREATE UNIQUE INDEX "helpdesk_faq_candidates_ticket_key"
    ON "helpdesk_faq_candidates"("ticket_id") WHERE "ticket_id" IS NOT NULL;

ALTER TABLE "helpdesk_faq_candidates" ADD CONSTRAINT "helpdesk_faq_candidates_merged_into_fkey"
    FOREIGN KEY ("merged_into") REFERENCES "helpdesk_faq_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 一轮至多归一个候选：挖掘只看还没归属的轮，所以重跑同一天不会重复计数
CREATE TABLE "helpdesk_faq_candidate_turns" (
    "turn_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_candidate_turns_pkey" PRIMARY KEY ("turn_id")
);

CREATE INDEX "helpdesk_faq_candidate_turns_candidate_idx" ON "helpdesk_faq_candidate_turns"("candidate_id");

ALTER TABLE "helpdesk_faq_candidate_turns" ADD CONSTRAINT "helpdesk_faq_candidate_turns_turn_fkey"
    FOREIGN KEY ("turn_id") REFERENCES "helpdesk_insight_turns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "helpdesk_faq_candidate_turns" ADD CONSTRAINT "helpdesk_faq_candidate_turns_candidate_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "helpdesk_faq_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 每个动作一行（谁、何时、改前 / 改后），与动作同一事务；只追加（触发器拒绝改与删）
CREATE TABLE "helpdesk_faq_candidate_revisions" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_candidate_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_candidate_revisions_action_check"
        CHECK ("action" IN ('create', 'grow', 'accept', 'dismiss', 'merge'))
);

CREATE INDEX "helpdesk_faq_candidate_revisions_candidate_idx"
    ON "helpdesk_faq_candidate_revisions"("candidate_id", "at");
ALTER TABLE "helpdesk_faq_candidate_revisions" ADD CONSTRAINT "helpdesk_faq_candidate_revisions_candidate_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "helpdesk_faq_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TRIGGER "helpdesk_faq_candidate_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_candidate_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();

-- ---------------------------------------------------------------------------
-- 4. 回归用例（G5）：接受的候选的脱敏例句，标成员工选的节点
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_eval_cases" (
    "id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "candidate_id" UUID,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'flywheel',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_eval_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_eval_cases_locale_check" CHECK ("locale" IN ('en-GB', 'zh-CN', 'zh-TW')),
    CONSTRAINT "helpdesk_faq_eval_cases_text_check" CHECK (char_length("text") BETWEEN 1 AND 500),
    CONSTRAINT "helpdesk_faq_eval_cases_source_check" CHECK ("source" IN ('flywheel', 'staff'))
);

CREATE UNIQUE INDEX "helpdesk_faq_eval_cases_text_key"
    ON "helpdesk_faq_eval_cases"("faq_id", "locale", lower("text"));
-- faq_id 不建外键：FAQ 只归档、不删；节点不在某一版里（归档了、不是入口）时评测门把用例计为 skipped。
-- 这样飞轮的表不改变 helpdesk_faqs 已有的生命周期（清理、导入）。
CREATE INDEX "helpdesk_faq_eval_cases_faq_idx" ON "helpdesk_faq_eval_cases"("faq_id");
ALTER TABLE "helpdesk_faq_eval_cases" ADD CONSTRAINT "helpdesk_faq_eval_cases_candidate_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "helpdesk_faq_candidates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 5. 后台任务的运行行
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_flywheel_runs" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    -- 这次运行算哪一个 UTC 日
    "run_day" DATE NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    -- 定时运行：同一天第几次尝试（失败重试，一天至多 3 次）
    "attempts" SMALLINT NOT NULL DEFAULT 1,
    "instance" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    -- 只有计数与枚举，从不含学员文字
    "stats" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "more_due" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "requested_by" UUID,
    "requested_by_name" TEXT,
    "idempotency_key" TEXT,

    CONSTRAINT "helpdesk_flywheel_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_flywheel_runs_job_check" CHECK ("job" IN ('gap_mining')),
    CONSTRAINT "helpdesk_flywheel_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
    CONSTRAINT "helpdesk_flywheel_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed')),
    CONSTRAINT "helpdesk_flywheel_runs_attempts_check" CHECK ("attempts" BETWEEN 1 AND 10),
    CONSTRAINT "helpdesk_flywheel_runs_finished_check"
        CHECK (("status" = 'running') = ("finished_at" IS NULL)),
    CONSTRAINT "helpdesk_flywheel_runs_manual_check"
        CHECK ("trigger" <> 'manual' OR ("requested_by" IS NOT NULL AND "idempotency_key" IS NOT NULL))
);

-- 每个任务每个 UTC 日至多一行定时运行（重试改同一行）
CREATE UNIQUE INDEX "helpdesk_flywheel_runs_day_key"
    ON "helpdesk_flywheel_runs"("job", "run_day") WHERE "trigger" = 'schedule';
CREATE UNIQUE INDEX "helpdesk_flywheel_runs_idempotency_key"
    ON "helpdesk_flywheel_runs"("job", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "helpdesk_flywheel_runs_recent_idx" ON "helpdesk_flywheel_runs"("job", "started_at" DESC);
