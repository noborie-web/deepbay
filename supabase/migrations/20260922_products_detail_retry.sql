-- 商品詳細の補完に失敗した商品を時間を置いて再試行するための列
ALTER TABLE products ADD COLUMN IF NOT EXISTS detail_attempts int NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS detail_retry_after timestamptz;
