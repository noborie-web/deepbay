ALTER TABLE products
  ADD COLUMN IF NOT EXISTS source_seller_id TEXT,
  ADD COLUMN IF NOT EXISTS source_seller_url TEXT;

CREATE INDEX IF NOT EXISTS idx_products_source_seller_id
  ON products(user_id, source_seller_id)
  WHERE source_seller_id IS NOT NULL;
