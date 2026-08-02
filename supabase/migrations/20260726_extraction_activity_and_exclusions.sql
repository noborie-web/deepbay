ALTER TYPE extraction_status ADD VALUE IF NOT EXISTS 'excluded' AFTER 'failed';

CREATE TABLE IF NOT EXISTS extraction_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id UUID NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (
    activity_type IN (
      'edited',
      'csv_exported',
      'specifics_csv_exported',
      'direct_listed',
      'excluded'
    )
  ),
  label TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS excluded_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id UUID NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  reason_code TEXT NOT NULL,
  reason_label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  original_title TEXT NOT NULL,
  original_price NUMERIC,
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (extraction_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_activities_extraction_created
  ON extraction_activities(extraction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_excluded_products_extraction_excluded
  ON excluded_products(extraction_id, excluded_at DESC);
CREATE INDEX IF NOT EXISTS idx_excluded_products_reason
  ON excluded_products(extraction_id, reason_code);

ALTER TABLE extraction_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE excluded_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_extraction_activities" ON extraction_activities;
CREATE POLICY "users_own_extraction_activities"
  ON extraction_activities FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_own_excluded_products" ON excluded_products;
CREATE POLICY "users_own_excluded_products"
  ON excluded_products FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
