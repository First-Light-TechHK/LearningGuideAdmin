-- Course history becomes the course event log: append-only, and readable as an outbox.
ALTER TABLE "CourseAuthoringActivity" ADD COLUMN "reason" TEXT;

-- The writing transaction's id. A consumer reading by "id" only takes rows whose txid is below
-- pg_snapshot_xmin(pg_current_snapshot()), so a row with a smaller id that commits later is not skipped.
ALTER TABLE "CourseAuthoringActivity"
  ADD COLUMN "txid" BIGINT NOT NULL DEFAULT ((pg_current_xact_id())::text)::bigint;

CREATE FUNCTION "course_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CourseAuthoringActivity is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "course_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "CourseAuthoringActivity"
  FOR EACH ROW EXECUTE FUNCTION "course_event_append_only"();

CREATE TRIGGER "course_event_no_truncate"
  BEFORE TRUNCATE ON "CourseAuthoringActivity"
  FOR EACH STATEMENT EXECUTE FUNCTION "course_event_append_only"();
