-- ユーザー要望: 商品編集画面の価格一括編集「価格帯別利益額」モードを
-- 一番よく使う予定だが、毎回同じ価格帯・利益額を入力し直すのが手間との
-- ことで、設定を保存・自動読み込みできるようにする。ユーザーにつき1件
-- (複数プロファイルではなく、直近保存した設定を常に自動読み込みする
-- シンプルな仕様)。
CREATE TABLE IF NOT EXISTS price_tier_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  tiers JSONB NOT NULL,
  ebay_fee_rate NUMERIC NOT NULL DEFAULT 0.133,
  shipping_jpy INTEGER NOT NULL DEFAULT 2000,
  fixed_cost_usd NUMERIC NOT NULL DEFAULT 0,
  ad_rate NUMERIC NOT NULL DEFAULT 0,
  customs_rate NUMERIC NOT NULL DEFAULT 0,
  discount_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE price_tier_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own price_tier_settings" ON price_tier_settings
  FOR ALL USING (auth.uid() = user_id);
