CREATE TABLE IF NOT EXISTS source_url_lookup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  lookup_code TEXT NOT NULL UNIQUE CHECK (
    lookup_code ~ '^ele_[0-9]{8}_[A-HJ-NP-Z2-9]{16}$'
  ),
  source_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  source_title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_source_url_lookup_codes_user_code
  ON source_url_lookup_codes(user_id, lookup_code);

ALTER TABLE source_url_lookup_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'source_url_lookup_codes'
      AND policyname = 'users_own_source_url_lookup_codes'
  ) THEN
    CREATE POLICY "users_own_source_url_lookup_codes"
      ON source_url_lookup_codes FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;
