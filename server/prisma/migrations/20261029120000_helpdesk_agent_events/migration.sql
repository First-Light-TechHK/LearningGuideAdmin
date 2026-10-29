-- Helpdesk Agent 链路追踪（helpdesk-agent-v2-pi-dsh §2，2026-10-29）：照 DeepSeek Harness 的
-- SessionEvent 日志，归 Agent（agent 角色）写。信封 {type, seq, time, data}：每个 run 的 seq 从 1
-- 连续（应用在 run 级 advisory lock 内分配），data 是无损 JSON，只追加、从不改写。
-- 唯一允许的 UPDATE 是 90 天后清学员原文：turn/start 去掉 input、assistant/message 去掉 text；
-- 其它 UPDATE 与 DELETE 一律被触发器拒绝。只加表，不改已有迁移。

-- CreateTable
CREATE TABLE "helpdesk_agent_events" (
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "time" TIMESTAMPTZ(6) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT "helpdesk_agent_events_pkey" PRIMARY KEY ("run_id", "seq"),
    CONSTRAINT "helpdesk_agent_events_seq_check" CHECK ("seq" >= 1),
    CONSTRAINT "helpdesk_agent_events_type_check" CHECK ("type" IN (
        'turn/start', 'step/start', 'request/context', 'request/header', 'assistant/message',
        'tool/call', 'tool/result', 'step/end', 'turn/end', 'feedback')),
    CONSTRAINT "helpdesk_agent_events_data_check" CHECK (jsonb_typeof("data") = 'object')
);

-- CreateIndex：90 天清理按时间；对话链按 turn/start 的 parentRunId
CREATE INDEX "helpdesk_agent_events_time_idx" ON "helpdesk_agent_events"("time");
CREATE INDEX "helpdesk_agent_events_parent_idx" ON "helpdesk_agent_events"(("data"->>'parentRunId'))
    WHERE "type" = 'turn/start';

-- 只追加
CREATE FUNCTION "helpdesk_agent_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW."run_id" = OLD."run_id" AND NEW."seq" = OLD."seq"
       AND NEW."type" = OLD."type" AND NEW."time" = OLD."time"
       AND ((OLD."type" = 'turn/start' AND NEW."data" = OLD."data" - 'input')
         OR (OLD."type" = 'assistant/message' AND NEW."data" = OLD."data" - 'text')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'helpdesk_agent_events is append-only (% refused)', TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "helpdesk_agent_events_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_agent_events"
    FOR EACH ROW EXECUTE FUNCTION "helpdesk_agent_events_append_only"();
