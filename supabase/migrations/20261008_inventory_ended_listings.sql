-- ユーザー報告(2026-10-08): 売れた商品のDBK-IDで暗号化復元を試したが
-- 「該当する商品が見つかりませんでした」になった。出品が終了すると
-- inventory_active_listings の行(CustomLabel ↔ 商品 ↔ eBay商品番号の
-- 対応表)を削除しているため、売却後は出品の記録が一切残らない。
-- 終了した出品を履歴として残し、売却後も仕入先URLを辿れるようにする。
create table if not exists inventory_ended_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  seller_account_id uuid references seller_accounts(id) on delete set null,
  ebay_item_id text not null,
  custom_label text,
  product_id uuid references products(id) on delete set null,
  title text,
  site_id text,
  currency text,
  last_price numeric,
  quantity_sold integer,
  -- 'sold' | 'delisted' | 'unknown'
  ended_reason text not null default 'unknown',
  -- 商品が後から削除されても辿れるよう、終了時点の仕入先URLを複製しておく
  source_url text,
  ended_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, ebay_item_id)
);

create index if not exists inventory_ended_listings_user_label_idx
  on inventory_ended_listings (user_id, custom_label);
create index if not exists inventory_ended_listings_user_product_idx
  on inventory_ended_listings (user_id, product_id);

alter table inventory_ended_listings enable row level security;

drop policy if exists "inventory_ended_listings: own rows only" on inventory_ended_listings;
create policy "inventory_ended_listings: own rows only" on inventory_ended_listings
  for all using (auth.uid() = user_id);
