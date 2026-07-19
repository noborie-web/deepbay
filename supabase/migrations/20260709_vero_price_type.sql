-- Veroブランドリスト
CREATE TABLE IF NOT EXISTS vero_brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vero_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vero_brands" ON vero_brands
  FOR ALL USING (auth.uid() = user_id);

-- products テーブルに価格タイプカラムを追加
-- 'fixed'=固定価格, 'auction'=オークション
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_type TEXT DEFAULT 'fixed';
