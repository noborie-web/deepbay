-- ユーザー要望・実データで確認した不具合:
-- eBayのConditionIDはカテゴリごとに有効な値が異なる。実際にCDカテゴリ
-- (176984)へアップロードしたところ、ConditionID=3000(Used)の138件が
-- 全て "The provided condition id is invalid for the selected primary
-- category id.|3000|CDs|CONDITION_ID|" で失敗し、1000(New)の13件のみ
-- 成功した。音楽・映像・ゲーム等のメディア系カテゴリは Used を持たず、
-- New / Like New(2750) / Very Good(4000) / Good(5000) / Acceptable(6000)
-- の階層になっているため。
-- 従来はコード内の固定マッピング + Video Games(139973)のみハードコード
-- の例外対応だったので、カテゴリごとに商品状態→ConditionIDの対応を
-- 設定できるようにする。NULLの場合は従来どおり標準マッピングを使う。
ALTER TABLE listing_categories
  ADD COLUMN IF NOT EXISTS condition_map JSONB;
