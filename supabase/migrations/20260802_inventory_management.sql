-- inventory_settings: per-user eBay OAuth credentials and sync preferences
CREATE TABLE IF NOT EXISTS inventory_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ebay_token  text,                          -- encrypted access token (stored as-is; refresh handled server-side)
  ebay_refresh_token text,
  ebay_token_expires_at timestamptz,
  sync_enabled boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE inventory_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_settings: own rows only" ON inventory_settings
  FOR ALL USING (auth.uid() = user_id);

-- inventory_active_listings: snapshot of active eBay listings fetched via GetMyeBaySelling
CREATE TABLE IF NOT EXISTS inventory_active_listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ebay_item_id    text NOT NULL,
  custom_label    text,                      -- SKU / CustomLabel from eBay
  title           text NOT NULL,
  current_price   numeric(12,2),
  quantity        integer,
  quantity_sold   integer,
  listing_status  text,
  start_time      timestamptz,
  end_time        timestamptz,
  source_url      text,                      -- restored from custom_label management code
  product_id      uuid REFERENCES products(id) ON DELETE SET NULL,
  raw_data        jsonb,                     -- full item data from eBay response
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ebay_item_id)
);

ALTER TABLE inventory_active_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_active_listings: own rows only" ON inventory_active_listings
  FOR ALL USING (auth.uid() = user_id);

-- inventory_runs: audit log of sync/upload operations
CREATE TABLE IF NOT EXISTS inventory_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_type    text NOT NULL CHECK (run_type IN ('sync', 'upload')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  items_total integer,
  items_matched integer,
  error_message text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_runs: own rows only" ON inventory_runs
  FOR ALL USING (auth.uid() = user_id);
