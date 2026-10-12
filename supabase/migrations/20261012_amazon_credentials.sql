-- ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品
-- したい。Amazonはbot対策が強くスクレイピングが安定しないため、SP-APIを使う。
-- LWAの認証情報(CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)を保存する。
--
-- eBayの ebay_account_credentials と同じ方針で、RLSは有効にしつつ
-- ユーザー向けポリシーは作らない(service role専用)。秘密情報は
-- アプリ側でAES-256-GCM暗号化してから入れる。
create table if not exists amazon_credentials (
  user_id uuid primary key references profiles(id) on delete cascade,
  -- CLIENT_IDは秘密ではないが、画面でマスクして出すため平文で持つ
  client_id text not null,
  client_secret_encrypted text not null,
  refresh_token_encrypted text not null,
  -- 日本 = A1VC38T7YXB528
  marketplace_id text not null default 'A1VC38T7YXB528',
  -- 接続確認(LWAトークン取得)が最後に成功した日時
  verified_at timestamptz,
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table amazon_credentials enable row level security;
