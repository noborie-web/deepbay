-- 抽出後に商品ページから詳細(説明文・状態・発送日数・評価数)を補完した/試みた日時。
-- ヤフオク・Yahoo!フリマは相手サイトのアクセス制限で抽出中に全件の詳細を取り切れない
-- ことがあるため、抽出完了後に残りを順次補完する(null = 未補完)。
ALTER TABLE products ADD COLUMN IF NOT EXISTS detail_enriched_at timestamptz;
CREATE INDEX IF NOT EXISTS products_detail_pending_idx
  ON products (extraction_id) WHERE detail_enriched_at IS NULL;
