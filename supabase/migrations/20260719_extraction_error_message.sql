-- extractions テーブルにエラーメッセージカラムを追加
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS error_message TEXT;
