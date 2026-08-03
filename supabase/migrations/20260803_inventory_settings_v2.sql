ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS ebay_auto_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS days_until_delist integer NOT NULL DEFAULT 29,
  ADD COLUMN IF NOT EXISTS daily_run_count integer NOT NULL DEFAULT 1;
