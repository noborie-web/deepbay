-- SOLD積み上げ管理テーブル
CREATE TABLE IF NOT EXISTS inventory_stacking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ebay_item_id text NOT NULL,
  new_source_url text,
  is_excluded boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ebay_item_id)
);

ALTER TABLE inventory_stacking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_stacking_user_policy" ON inventory_stacking
  FOR ALL USING (auth.uid() = user_id);

-- 重複チェック設定テーブル
CREATE TABLE IF NOT EXISTS inventory_duplicate_check_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  check_columns text[] NOT NULL DEFAULT ARRAY['url', 'title'],
  auto_check boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 1,
  last_checked_at timestamptz,
  last_found_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_duplicate_check_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory_dup_check_user_policy" ON inventory_duplicate_check_configs
  FOR ALL USING (auth.uid() = user_id);
