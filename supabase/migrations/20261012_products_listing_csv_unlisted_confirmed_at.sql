-- ユーザー要望(2026-10-12): 出品CSVに出したのに在庫管理に入っていない商品の
-- 警告は、「eBayが弾いて出品されなかった」場合も同じ扱いになる。実際、
-- 10/11のアップロードでは Durability Guarantee の値不正(No / null)などで
-- 12件が弾かれていた。失敗したまま放置すると警告が消えず、新たな漏れに
-- 気づきにくくなるので、「出品されなかったと確認済み」として警告から
-- 外せるようにする。
--
-- listing_csv_exported_at は消さない(消すと商品削除の安全装置(#270)まで
-- 外れてしまう)。確認した日時を別に持ち、警告の集計からだけ除く。
alter table products add column if not exists listing_csv_unlisted_confirmed_at timestamptz;
