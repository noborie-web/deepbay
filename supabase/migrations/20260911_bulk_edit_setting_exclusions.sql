-- ユーザー要望: 公式ツールのように、一括編集設定(bulk_edit_settings)ごとに
-- 除外条件(Vero/危険セラー/危険単語/価格範囲/評価数/最終更新/発送日数)を
-- 個別に有効・無効切り替えできるようにしたい。これまでは抽出設定
-- (extraction_settings、ユーザーにつき1件)がグローバルに1つだけ存在し、
-- どの一括編集設定を使っても同じ閾値が適用されていた。
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS memo TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vero_exclude_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS danger_seller_exclude_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS danger_word_exclude_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS price_range_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_min INTEGER,
  ADD COLUMN IF NOT EXISTS price_max INTEGER,
  ADD COLUMN IF NOT EXISTS rating_exclude_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rating_min INTEGER,
  ADD COLUMN IF NOT EXISTS shipping_days_exclude_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipping_days_max INTEGER,
  ADD COLUMN IF NOT EXISTS updated_months_exclude_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_months_ago INTEGER;

-- 既存の一括編集設定プロファイルへ、これまでグローバルに適用されていた
-- 抽出設定(extraction_settings)の閾値を引き継ぐ(移行時点でユーザーの
-- 抽出結果が変わらないようにするため)。以後はプロファイルごとに個別に
-- 変更可能になる。
UPDATE bulk_edit_settings b
SET
  price_min = s.price_min,
  price_max = s.price_max,
  price_range_enabled = (s.price_min IS NOT NULL OR s.price_max IS NOT NULL),
  rating_min = s.rating_min,
  rating_exclude_enabled = (s.rating_min IS NOT NULL),
  shipping_days_max = s.shipping_days_max,
  shipping_days_exclude_enabled = (s.shipping_days_max IS NOT NULL),
  updated_months_ago = s.updated_months_ago,
  updated_months_exclude_enabled = (s.updated_months_ago IS NOT NULL)
FROM extraction_settings s
WHERE s.user_id = b.user_id;
