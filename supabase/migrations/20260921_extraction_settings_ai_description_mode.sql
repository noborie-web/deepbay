-- ユーザー要望: 説明文をAIで生成する。off=生成しない / missing=説明文が取れなかった商品だけ / all=全商品
ALTER TABLE extraction_settings
  ADD COLUMN IF NOT EXISTS ai_description_mode text NOT NULL DEFAULT 'missing';
