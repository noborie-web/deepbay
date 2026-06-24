-- =============================================
-- DeepBay Initial Schema
-- =============================================

-- プラン種別
CREATE TYPE plan_type AS ENUM ('free', 'basic', 'pro', 'enterprise');

-- 抽出ステータス
CREATE TYPE extraction_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- 出品ステータス
CREATE TYPE listing_status AS ENUM ('draft', 'listed', 'sold', 'delisted');

-- =============================================
-- ユーザープロファイル（auth.usersと連携）
-- =============================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  plan plan_type NOT NULL DEFAULT 'free',
  extraction_limit INTEGER NOT NULL DEFAULT 30,   -- 月間抽出可能回数
  extraction_used INTEGER NOT NULL DEFAULT 0,      -- 今月使用した回数
  plan_reset_at TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- セラーアカウント（eBayのセラーID管理）
-- =============================================
CREATE TABLE seller_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,          -- eBayセラーID（例: miyabi-24）
  display_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 出品カテゴリ
-- =============================================
CREATE TABLE listing_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,               -- カテゴリ名（例: トップス）
  ebay_category_id TEXT,            -- eBayカテゴリ番号（例: 53159）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 一括編集設定（抽出時の変換ルール）
-- =============================================
CREATE TABLE bulk_edit_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,               -- 設定名（例: 設定1）
  price_rate NUMERIC(5,2) DEFAULT 1.0,  -- 価格倍率
  title_prefix TEXT DEFAULT '',
  title_suffix TEXT DEFAULT '',
  description_template TEXT DEFAULT '',
  condition_mapping JSONB DEFAULT '{}',  -- 状態マッピング（日本語→英語）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 抽出ジョブ
-- =============================================
CREATE TABLE extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,                        -- 抽出元URL
  source_site TEXT NOT NULL,                       -- サイト名（mercari/yahoo_auction等）
  seller_account_id UUID REFERENCES seller_accounts(id),
  category_id UUID REFERENCES listing_categories(id),
  bulk_edit_setting_id UUID REFERENCES bulk_edit_settings(id),
  status extraction_status NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,             -- 進捗 0-100
  memo TEXT DEFAULT '',
  is_bulk BOOLEAN NOT NULL DEFAULT false,          -- 一括 or シングル
  extracted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 抽出された商品（在庫）
-- =============================================
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  extraction_id UUID REFERENCES extractions(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  source_item_id TEXT,                             -- 元サイトの商品ID
  -- 元データ
  original_title TEXT NOT NULL,
  original_price INTEGER,                          -- 元価格（円）
  original_description TEXT,
  original_images JSONB DEFAULT '[]',              -- 画像URL配列
  original_condition TEXT,
  -- eBay用データ（編集後）
  ebay_title TEXT,
  ebay_price NUMERIC(10,2),
  ebay_description TEXT,
  ebay_images JSONB DEFAULT '[]',
  ebay_condition TEXT,
  ebay_category_id TEXT,
  listing_status listing_status NOT NULL DEFAULT 'draft',
  listed_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 対応スクレイパー（サイト管理）
-- =============================================
CREATE TABLE scrapers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,               -- サイト名（例: メルカリ）
  site_key TEXT NOT NULL UNIQUE,    -- 内部キー（例: mercari）
  url_pattern TEXT NOT NULL,        -- URLマッチパターン（例: mercari.com）
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- デフォルトスクレイパー登録
INSERT INTO scrapers (name, site_key, url_pattern) VALUES
  ('メルカリ', 'mercari', 'mercari.com'),
  ('ヤフオク', 'yahoo_auction', 'auctions.yahoo.co.jp'),
  ('ラクマ', 'rakuma', 'fril.jp'),
  ('PayPayフリマ', 'paypay_flea', 'paypayfleamarket.yahoo.co.jp');

-- =============================================
-- インデックス
-- =============================================
CREATE INDEX idx_extractions_user_id ON extractions(user_id);
CREATE INDEX idx_extractions_status ON extractions(status);
CREATE INDEX idx_extractions_created_at ON extractions(created_at DESC);
CREATE INDEX idx_products_user_id ON products(user_id);
CREATE INDEX idx_products_listing_status ON products(listing_status);
CREATE INDEX idx_products_extraction_id ON products(extraction_id);

-- =============================================
-- Row Level Security (RLS)
-- =============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_edit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- 自分のデータのみ読み書き可能
CREATE POLICY "users_own_profile" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "users_own_sellers" ON seller_accounts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_categories" ON listing_categories FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_bulk_settings" ON bulk_edit_settings FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_extractions" ON extractions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_products" ON products FOR ALL USING (auth.uid() = user_id);

-- scrapersは全員読み取り可能
ALTER TABLE scrapers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scrapers_public_read" ON scrapers FOR SELECT USING (true);

-- =============================================
-- 新規ユーザー登録時にprofileを自動作成
-- =============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
