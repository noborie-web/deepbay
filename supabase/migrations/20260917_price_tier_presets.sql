-- ユーザー要望: 段階利益(価格帯別利益額)の設定を「デフォルト設定1(控えめ)」
-- 「デフォルト設定2(積極)」のように名前を付けて複数保存し、切り替えて
-- 使えるようにする。price_tier_settings(ユーザーにつき1件の「現在の設定」)
-- はそのまま残し、プリセットは別テーブルで管理する。
CREATE TABLE IF NOT EXISTS price_tier_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tiers JSONB NOT NULL,
  ebay_fee_rate NUMERIC NOT NULL DEFAULT 0.133,
  shipping_jpy INTEGER NOT NULL DEFAULT 2000,
  fixed_cost_usd NUMERIC NOT NULL DEFAULT 0,
  ad_rate NUMERIC NOT NULL DEFAULT 0,
  customs_rate NUMERIC NOT NULL DEFAULT 0,
  discount_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE price_tier_presets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own price_tier_presets" ON price_tier_presets
  FOR ALL USING (auth.uid() = user_id);
