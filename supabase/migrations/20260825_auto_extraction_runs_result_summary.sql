ALTER TABLE auto_extraction_runs
  ADD COLUMN IF NOT EXISTS result_summary jsonb;
