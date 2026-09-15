-- ユーザー要望: 「為替は出品時の為替との差で再計算」。eBay価格を計算・設定
-- した時点の為替レート(円/ドル)を商品ごとに保存し、仕入先チェックでは
-- 保存したレートと現在レートの比率で価格をスケールする(価格一括編集で
-- 手動調整した価格も維持したまま、為替変動分だけを反映できる)。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pricing_jpy_per_usd numeric;

-- 公式ツールの「価格追従ファイル絞り込み設定」相当。価格の更新幅による
-- 絞り込み(差分検知タイプ: 指定なし/プラスのみ/マイナスのみ、検知差分率%)。
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS price_change_direction text NOT NULL DEFAULT 'any'
    CHECK (price_change_direction IN ('any', 'up', 'down')),
  ADD COLUMN IF NOT EXISTS price_change_threshold_rate numeric NOT NULL DEFAULT 1;
