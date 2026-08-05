-- 在庫管理アクション設定カラム追加
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS auto_delist boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_revise_price boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_stack boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_time text, -- HH:MM形式（例: '09:00'）
  ADD COLUMN IF NOT EXISTS payment_profile_name text,
  ADD COLUMN IF NOT EXISTS return_profile_name text,
  ADD COLUMN IF NOT EXISTS shipping_profile_name text;

-- inventory_runsのrun_typeに新しい値を許容（既存のCHECK制約があれば削除）
ALTER TABLE inventory_runs DROP CONSTRAINT IF EXISTS inventory_runs_run_type_check;
