-- Clear legacy Mercari prices that copied JPY source prices into USD fields.
-- Restrict cleanup to unlisted draft products and only exact source-price matches.
UPDATE products
SET
  ebay_price = NULL,
  updated_at = NOW()
WHERE source_site = 'mercari'
  AND listing_status = 'draft'
  AND listed_at IS NULL
  AND ebay_price IS NOT NULL
  AND original_price IS NOT NULL
  AND ebay_price = original_price;
