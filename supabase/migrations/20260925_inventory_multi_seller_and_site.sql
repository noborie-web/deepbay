-- ユーザー要望(2026-09-25): 出品アカウントを複数運用し、UK/AUにも出品する。
-- 在庫管理でアカウントやサイト(通貨)が混在すると、他アカウントの出品を
-- 取り下げたり、GBP価格をUSDとして値下げする事故につながるため、出品ごとに
-- 「どのセラーの、どのサイトの、どの通貨の出品か」を必ず記録する。
alter table public.seller_accounts
  add column if not exists inventory_enabled boolean not null default true,
  add column if not exists inventory_discovery_scanned_until timestamptz,
  add column if not exists inventory_sync_cursor_item_id text;

alter table public.inventory_active_listings
  add column if not exists seller_account_id uuid references public.seller_accounts(id) on delete set null,
  add column if not exists site_id text not null default 'US',
  add column if not exists currency text not null default 'USD',
  -- 価格追従で「出品時の利益額」を維持するための基準レート(円/出品通貨)。
  -- US出品は従来どおり products.pricing_jpy_per_usd を使う。
  add column if not exists pricing_jpy_per_currency numeric;

create index if not exists inventory_active_listings_seller_idx
  on public.inventory_active_listings (user_id, seller_account_id);

-- 既存の出品は、最初に接続した1つのセラー(=これまで唯一の在庫管理対象)のもの。
update public.inventory_active_listings l
set seller_account_id = s.id
from (
  select distinct on (user_id) user_id, id
  from public.seller_accounts
  where ebay_connected_at is not null
  order by user_id, ebay_connected_at asc
) s
where l.seller_account_id is null and s.user_id = l.user_id;

-- 走査位置(新規出品の発見・同期カーソル)はセラー単位に持ち替える。
update public.seller_accounts s
set inventory_discovery_scanned_until = i.discovery_scanned_until,
    inventory_sync_cursor_item_id = i.sync_cursor_item_id
from public.inventory_settings i
where i.user_id = s.user_id
  and s.id = (
    select id from public.seller_accounts s2
    where s2.user_id = i.user_id and s2.ebay_connected_at is not null
    order by s2.ebay_connected_at asc limit 1
  );
