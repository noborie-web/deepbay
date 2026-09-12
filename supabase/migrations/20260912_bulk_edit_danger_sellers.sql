-- ユーザー要望: 危険Seller除外の段階②(一括編集設定による追加除外)を
-- 実際に機能させるため、一括編集設定プロファイルごとに独立した危険
-- セラーURLリストを持てるようにする(これまでグローバルリストを
-- 再チェックするだけで常に0件だった)。
CREATE TABLE IF NOT EXISTS bulk_edit_danger_sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_edit_setting_id UUID NOT NULL REFERENCES bulk_edit_settings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seller_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bulk_edit_danger_sellers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own bulk_edit_danger_sellers" ON bulk_edit_danger_sellers
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_bulk_edit_danger_sellers_setting ON bulk_edit_danger_sellers(bulk_edit_setting_id);
