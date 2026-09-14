-- ユーザー要望: 「N日経過取り下げ」にON/OFF設定を追加する。
-- 取り下げは「仕入先が売り切れ(在庫0)」かつ「出品からN日以上経過」の
-- 商品を対象にするが、これを無効化する手段がなく、経過日数を最大の
-- 365日にして実質的に回避する運用になっていた。
-- OFFにすると経過日数による取り下げを行わない(取り下げ対象0件、
-- 自動取り下げも実行しない)。既存ユーザーの挙動を変えないよう
-- デフォルトはON(true)。
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS delist_by_age_enabled boolean NOT NULL DEFAULT true;
