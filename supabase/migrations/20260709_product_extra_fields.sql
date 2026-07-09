-- products テーブルに評価数・発送日数・最終更新日カラムを追加
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS seller_rating_count INTEGER,
  ADD COLUMN IF NOT EXISTS shipping_days INTEGER,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
