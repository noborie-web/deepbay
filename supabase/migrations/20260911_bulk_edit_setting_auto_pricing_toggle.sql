-- ユーザー要望: 一括編集設定「全体」のON/OFF(is_enabled)とは別に、
-- 「抽出時の価格自動計算」だけを個別にON/OFFしたい(他の項目は
-- そのまま有効にしておきたいケース)。無効時はeBay出品価格を自動計算
-- せず未設定のままにする(後で手動設定する想定)。
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS auto_pricing_enabled BOOLEAN NOT NULL DEFAULT true;
