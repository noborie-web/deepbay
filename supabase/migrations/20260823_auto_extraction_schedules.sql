CREATE TABLE IF NOT EXISTS auto_extraction_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text,
  source_url text NOT NULL,
  seller_account_id uuid REFERENCES seller_accounts(id),
  category_id uuid REFERENCES listing_categories(id),
  bulk_edit_setting_id uuid REFERENCES bulk_edit_settings(id),
  process_type text NOT NULL DEFAULT 'extract'
    CHECK (process_type IN ('extract', 'extract_and_list')),
  schedule_day_of_month integer
    CHECK (schedule_day_of_month BETWEEN 1 AND 28),
  schedule_time text
    CHECK (schedule_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_extraction_schedules_user_id
  ON auto_extraction_schedules(user_id);

ALTER TABLE auto_extraction_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_auto_extraction_schedules"
  ON auto_extraction_schedules
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
