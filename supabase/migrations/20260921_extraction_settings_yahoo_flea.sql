-- ユーザー要望: ヤフオクの検索URLで抽出するとき、同じ条件でYahoo!フリマも検索して合算する
ALTER TABLE extraction_settings
  ADD COLUMN IF NOT EXISTS yahoo_auction_include_flea boolean NOT NULL DEFAULT true;
