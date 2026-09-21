-- 新規出品の発見(GetSellerListの期間走査)で前回どこまで走査したかを記録する。
-- CSVで出品した商品が「新しい順400件」の走査から漏れて下書きのまま残った
-- 不具合への対応。
ALTER TABLE inventory_settings
  ADD COLUMN IF NOT EXISTS discovery_scanned_until timestamptz;
