-- 一括編集設定を、抽出時の除外・商品フィルターまで保存できるよう拡張
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS memo TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS bulk_edit_settings_one_default_per_user
  ON bulk_edit_settings(user_id)
  WHERE is_default = true;

