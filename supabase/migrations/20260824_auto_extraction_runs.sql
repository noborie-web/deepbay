CREATE TABLE IF NOT EXISTS auto_extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES auto_extraction_schedules(id) ON DELETE CASCADE,
  extraction_id uuid REFERENCES extractions(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_extraction_runs_schedule_created
  ON auto_extraction_runs(schedule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_extraction_runs_user_created
  ON auto_extraction_runs(user_id, created_at DESC);

ALTER TABLE auto_extraction_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_auto_extraction_runs"
  ON auto_extraction_runs
  FOR SELECT
  USING (auth.uid() = user_id);
