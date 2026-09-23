-- ユーザー要望: 仕入先のタイトルが変わった商品は別商品への差し替えとみなして取り下げる
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS delist_on_title_change boolean NOT NULL DEFAULT true;
