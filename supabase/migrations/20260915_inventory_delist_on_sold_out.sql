-- ユーザー要望: 「仕入先が売り切れたら即取り下げ(N日経過を待たない)」。
-- 従来の取り下げは「売り切れ かつ 出品からN日経過」の両方が必要だったが、
-- 売り切れが分かった時点でeBayの数量を0にできるようにする。
-- 既存ユーザーの挙動を変えないようデフォルトはOFF(false)。
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS delist_on_sold_out boolean NOT NULL DEFAULT false;

-- 自動取り下げ(数量0へのRevise)を実行済みの出品を記録し、毎日同じ出品へ
-- 繰り返しReviseしないようにする。
ALTER TABLE inventory_active_listings
  ADD COLUMN IF NOT EXISTS delisted_at timestamptz;
