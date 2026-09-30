-- ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
-- eBayの GetApiAccessRules は廃止(HTTP 410)されていて使えないため、
-- Kakehashi側で自分の呼び出し回数を記録する。
-- 競合を避けるため追記のみ(集計は読み出し時に行う)。
create table if not exists public.ebay_api_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  -- eBayの呼び出し枠は太平洋時間の日付で切り替わるため、その日付で集計する
  called_on date not null,
  call_name text not null,
  count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ebay_api_calls_user_day_idx
  on public.ebay_api_calls (user_id, called_on);

alter table public.ebay_api_calls enable row level security;

drop policy if exists "ebay_api_calls_select_own" on public.ebay_api_calls;
create policy "ebay_api_calls_select_own" on public.ebay_api_calls
  for select using (auth.uid() = user_id);
