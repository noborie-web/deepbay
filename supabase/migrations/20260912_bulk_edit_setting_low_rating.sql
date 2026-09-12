-- ユーザー要望: 公式ツールの「低評価数除外」(セラーの悪い評価件数が
-- 許容数を超えたら除外)に相当する機能を、一括編集設定プロファイル
-- ごとに追加できるようにする。
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS low_rating_exclude_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_rating_max INTEGER;
