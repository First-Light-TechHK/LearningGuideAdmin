CREATE TABLE IF NOT EXISTS ai_evaluation_tasks (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','stopping','stopped','completed')),
  payload jsonb NOT NULL,
  source bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_evaluation_tasks_owner_created ON ai_evaluation_tasks(owner,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_evaluation_tasks_pending ON ai_evaluation_tasks(created_at) WHERE status IN ('queued','running','stopping');

ALTER TABLE ai_evaluation_tasks ADD COLUMN IF NOT EXISTS submission_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluation_tasks_submission ON ai_evaluation_tasks(owner,submission_key);
