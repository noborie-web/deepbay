-- ユーザー要望: 出品CSVを出力した抽出に「出力済み」と表示したい
-- (「編集済み」バッジの下)。出品CSV(2種)を出力した日時を記録する。
ALTER TABLE extractions
  ADD COLUMN IF NOT EXISTS csv_exported_at timestamptz;
