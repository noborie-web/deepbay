-- 抽出時の自動除外(Phase 2): 評価数・発送日数・最終更新月・価格範囲・
-- スポット文字は、これまで商品編集画面の除外パネルを開くたびに閾値を
-- その場で入力する仕様で、サーバー側に保存する場所が無かった。
-- 抽出時に自動適用できるよう、抽出設定に閾値を保存できるようにする。
-- いずれもNULL=無効(判定しない)。

ALTER TABLE extraction_settings
  ADD COLUMN IF NOT EXISTS rating_min INTEGER,
  ADD COLUMN IF NOT EXISTS shipping_days_max INTEGER,
  ADD COLUMN IF NOT EXISTS updated_months_ago INTEGER,
  ADD COLUMN IF NOT EXISTS price_min INTEGER,
  ADD COLUMN IF NOT EXISTS price_max INTEGER,
  ADD COLUMN IF NOT EXISTS price_target TEXT DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS spot_check_title BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS spot_check_description BOOLEAN NOT NULL DEFAULT true;

-- スポット文字テーブル(危険単語と同じ構造)
CREATE TABLE IF NOT EXISTS spot_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE spot_words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own spot_words" ON spot_words
  FOR ALL USING (auth.uid() = user_id);
