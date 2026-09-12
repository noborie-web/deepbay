-- バグ修正: 商品編集画面の手動「危険セラー除外」パネル
-- (product-exclusion.ts の findDangerSellerProductIds)は、
-- 各商品のsource_url(商品ページURL)を登録済み危険セラーURL
-- (出品者プロフィールURL)と比較していたが、この2つは全く形の異なる
-- URLのため、startsWith判定が構造的に成立せずほぼ常に0件になっていた。
-- 抽出時点ではスクレイパーがsellerUrl(出品者URL)を取得しているが、
-- productsテーブルに保存されず破棄されていたため、後から比較する
-- 手段が無かった。抽出時に保存できるようにする。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS seller_url TEXT;
