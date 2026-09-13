-- ユーザー要望: specifics-in(外部ツール)向けCSV出力のjp_spec列が、公式
-- ツールでは仕入元サイトの生データ(カテゴリ階層・出品者情報・商品状態
-- など)をほぼそのまま含んでいるのに対し、Kakehashiは数フィールドだけの
-- 簡易オブジェクトしか出力していなかった。specifics-inはこの生データから
-- カテゴリ別のItem Specificsを自動生成しているため、情報不足により誤った
-- フィールドセット(例: CDなのにゲーム向け項目)が生成される原因になって
-- いた。抽出時にスクレイパーが取得している生レスポンスを保存できるように
-- する。
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS raw_source_data JSONB;
