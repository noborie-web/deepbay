-- ユーザー要望(2026-09-25): miyabi-24 はUS、akebono-32 はUK/AUに出品する。
-- アカウントごとに出品サイトを登録しておき、CSV出力のサイト選択を既定でそれに
-- 合わせて、サイトの取り違え(混在)を防ぐ。
alter table public.seller_accounts
  add column if not exists listing_site_ids text[] not null default array['US']::text[];
