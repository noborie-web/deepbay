ALTER TABLE inventory_active_listings
  ADD COLUMN IF NOT EXISTS supplier_checked_at timestamptz;
