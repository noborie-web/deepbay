-- ユーザー要望(2026-09-30): 出品アカウントごとに「API自動運用」と「CSV運用のみ」を
-- 選べるようにしたい。CSVのみのセラーは、eBay APIを使う処理(同期・取り下げ・
-- 価格改定)の対象から外す。仕入先チェック(eBay APIを使わない)は引き続き行い、
-- 対象の検出とCSV出力はできるようにする。
alter table public.seller_accounts
  add column if not exists inventory_mode text not null default 'auto';

alter table public.seller_accounts
  drop constraint if exists seller_accounts_inventory_mode_check;

alter table public.seller_accounts
  add constraint seller_accounts_inventory_mode_check
  check (inventory_mode in ('auto', 'csv'));
