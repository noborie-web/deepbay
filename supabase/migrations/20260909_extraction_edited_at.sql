-- ユーザー要望: 既存ツール(公式)の抽出一覧と同様、商品編集画面で保存した
-- 抽出には「編集済み」バッジを表示したい。最初に編集保存した日時を記録する。
ALTER TABLE extractions
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
