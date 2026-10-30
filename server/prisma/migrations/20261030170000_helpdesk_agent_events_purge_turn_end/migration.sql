-- Helpdesk v5: turn/end now carries `output` (the short lines shown to the learner, which can
-- restate learner text). The 90-day purge removes it like turn/start.input and
-- assistant/message.text, so the append-only trigger must allow exactly that one rewrite too.
-- Every other UPDATE and every DELETE stays refused.
CREATE OR REPLACE FUNCTION "helpdesk_agent_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW."run_id" = OLD."run_id" AND NEW."seq" = OLD."seq"
       AND NEW."type" = OLD."type" AND NEW."time" = OLD."time"
       AND ((OLD."type" = 'turn/start' AND NEW."data" = OLD."data" - 'input')
         OR (OLD."type" = 'assistant/message' AND NEW."data" = OLD."data" - 'text')
         OR (OLD."type" = 'turn/end' AND NEW."data" = OLD."data" - 'output')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'helpdesk_agent_events is append-only (% refused)', TG_OP
        USING ERRCODE = '55000';
END;
$$;
