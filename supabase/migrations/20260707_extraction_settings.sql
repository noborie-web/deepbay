-- 抽出設定テーブル（ユーザーごと1件）
CREATE TABLE IF NOT EXISTS extraction_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL UNIQUE,
  title_engine text DEFAULT 'high',
  title_enabled boolean DEFAULT true,
  brand_engine text DEFAULT 'high',
  brand_enabled boolean DEFAULT true,
  description_engine text DEFAULT 'high',
  description_enabled boolean DEFAULT true,
  exclude_active_duplicate boolean DEFAULT true,
  exclude_title_duplicate boolean DEFAULT false,
  exclude_translated_duplicate boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 危険セラーテーブル
CREATE TABLE IF NOT EXISTS danger_sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  seller_url text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 危険単語テーブル
CREATE TABLE IF NOT EXISTS danger_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  word text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 置換単語テーブル
CREATE TABLE IF NOT EXISTS replace_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  before_word text NOT NULL,
  after_word text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- HTMLテンプレートテーブル
CREATE TABLE IF NOT EXISTS html_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  name text NOT NULL,
  content text NOT NULL DEFAULT '',
  is_active boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE extraction_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE danger_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE danger_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE replace_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE html_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own" ON extraction_settings FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own" ON danger_sellers FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own" ON danger_words FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own" ON replace_words FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own" ON html_templates FOR ALL USING (auth.uid() = user_id);
