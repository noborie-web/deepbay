-- 本番で判明した問題(2026-10-09): CSVで出品した商品は eBay から ItemID が
-- 戻らないため products.ebay_item_id が null のままで、在庫管理にも載って
-- いなかった。商品削除の安全装置は「ebay_item_id がある」「在庫管理に載って
-- いる」のどちらかでしか止めないため、CSV出品した商品は素通りで削除できて
-- しまい、eBayには kakehashi_<UUID> ラベルの出品だけが残った(626件)。
-- 仕入先URLは商品にしか無いので、削除されると追跡不能になる。
-- 出品CSVに出力した日時を商品に記録し、削除時の警告に使う。
alter table products add column if not exists listing_csv_exported_at timestamptz;

create index if not exists products_listing_csv_exported_at_idx
  on products (user_id, listing_csv_exported_at)
  where listing_csv_exported_at is not null;
