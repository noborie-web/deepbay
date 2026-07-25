ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ebay_item_specifics JSONB NOT NULL DEFAULT '{}'::jsonb;
