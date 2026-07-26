ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'listing' BEFORE 'listed';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ebay_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_products_ebay_item_id
  ON products(ebay_item_id)
  WHERE ebay_item_id IS NOT NULL;
