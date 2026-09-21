-- 説明文をAIで生成した日時(手動実行の重複防止用。null=未生成)
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_description_generated_at timestamptz;
