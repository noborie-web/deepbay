-- ユーザー要望: CSV出力(通常出品用・specifics-in用)のItem Specifics列が、
-- 全カテゴリ共通の固定リスト(ゲーム向け)にハードコードされており、
-- 音楽CD等の別カテゴリでは必要な項目(Artist, Record Label等)が出力
-- されない問題があった。eBayのTaxonomy API
-- (get_item_aspects_for_category)からカテゴリごとの実際の項目名を
-- 取得してキャッシュする。
CREATE TABLE IF NOT EXISTS ebay_category_aspects (
  category_id TEXT PRIMARY KEY,
  category_tree_id TEXT NOT NULL DEFAULT '0',
  aspect_names JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
