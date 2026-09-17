-- ユーザー要望: 出品済み商品の説明文(日本語のまま)を英訳し、eBayの説明文を
-- 差し替える。eBayへ反映済みかを商品ごとに記録する。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description_synced_at timestamptz;
