-- ユーザー要望: 「公式ツールはタイトルの差分も検知しています」。
-- 仕入先チェックで取得した仕入先の最新タイトル・最新価格(円)を出品ごとに
-- 保存し、抽出時のタイトル(products.original_title)・価格
-- (products.original_price)との差分を検知する。差分検知ファイル(diff)は
-- この値から生成する。
ALTER TABLE inventory_active_listings
  ADD COLUMN IF NOT EXISTS supplier_title text,
  ADD COLUMN IF NOT EXISTS supplier_price_jpy numeric,
  ADD COLUMN IF NOT EXISTS supplier_diff jsonb,
  ADD COLUMN IF NOT EXISTS supplier_diff_detected_at timestamptz;
