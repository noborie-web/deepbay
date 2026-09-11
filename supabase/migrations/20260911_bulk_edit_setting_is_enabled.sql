-- ユーザー要望: 一括編集設定「全体」のON/OFFを切り替えられるようにしたい。
-- 個々の除外項目の有効/無効(20260911_bulk_edit_setting_exclusions.sql)
-- とは別に、プロファイル自体をまるごと無効化できるマスタースイッチ。
-- 無効化されたプロファイルは、抽出時にそのプロファイルが選択されて
-- いても一切適用されない(未選択時のデフォルト挙動にフォールバックする)。
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT true;
