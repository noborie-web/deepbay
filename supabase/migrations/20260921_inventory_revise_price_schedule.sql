-- ユーザー要望: 1日の稼働回数(最大4回)と、価格改定を毎回行うか朝のみにするか
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS revise_price_schedule text NOT NULL DEFAULT 'every';
