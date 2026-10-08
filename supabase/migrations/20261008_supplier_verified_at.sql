-- ユーザー要望(2026-10-08): 在庫切れを厳格にチェックしたい。
-- これまで supplier_checked_at は「確認を試みた日時」で、429やネットワーク
-- エラーで中身を見られなかった場合も更新していた(429のみ例外)。そのため
-- 「何日も仕入先を確認できていない出品」を区別できず、在庫が無いまま
-- 出品され続けることがあった。
-- 実際に仕入先の在庫を確認できた日時を別に記録する。
alter table inventory_active_listings
  add column if not exists supplier_verified_at timestamptz;

-- 既存行は、これまでの確認日時を「確認できた日時」の近似として引き継ぐ
-- (null のままだと導入直後に全件が「未確認」と判定されてしまう)。
update inventory_active_listings
  set supplier_verified_at = supplier_checked_at
  where supplier_verified_at is null and supplier_checked_at is not null;

-- 未確認が続く出品の自動取り下げ設定
alter table inventory_settings
  add column if not exists delist_on_unverified boolean not null default true,
  add column if not exists unverified_delist_hours integer not null default 24;

alter table inventory_settings drop constraint if exists inventory_settings_unverified_delist_hours_check;
alter table inventory_settings add constraint inventory_settings_unverified_delist_hours_check
  check (unverified_delist_hours between 1 and 720);
