ALTER TABLE seller_accounts
  ADD COLUMN IF NOT EXISTS ebay_user_id TEXT,
  ADD COLUMN IF NOT EXISTS ebay_marketplace_id TEXT NOT NULL DEFAULT 'EBAY_US',
  ADD COLUMN IF NOT EXISTS ebay_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ebay_policy_cache JSONB,
  ADD COLUMN IF NOT EXISTS ebay_policy_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS seller_accounts_user_ebay_user_uidx
  ON seller_accounts(user_id, ebay_user_id)
  WHERE ebay_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ebay_account_credentials (
  seller_account_id UUID PRIMARY KEY REFERENCES seller_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  refresh_token_encrypted TEXT NOT NULL,
  token_scopes TEXT[] NOT NULL DEFAULT '{}',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ebay_account_credentials ENABLE ROW LEVEL SECURITY;

-- 認証情報はservice role専用。ユーザー向けRLSポリシーは意図的に作成しない。
