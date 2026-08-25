ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS profit_rate numeric,
  ADD COLUMN IF NOT EXISTS ebay_fee_rate numeric,
  ADD COLUMN IF NOT EXISTS shipping_cost_jpy integer,
  ADD COLUMN IF NOT EXISTS fixed_cost_usd numeric;
