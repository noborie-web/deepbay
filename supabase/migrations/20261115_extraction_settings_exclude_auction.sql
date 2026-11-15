-- ユーザー要望(2026-11-15): オークション商品を抽出時に自動除外する。
--
-- オークションは即決で仕入れられず、入札で値が上がるため、eBayで売れても
-- 赤字・仕入れ不能になりうる(2026-10-20に実際に発生)。既定は除外する。
-- ヤフオクは「即決価格の無いオークション」だけが対象で、即決価格のある
-- 出品は price_type が fixed のため影響を受けない。
alter table extraction_settings
  add column if not exists exclude_auction boolean not null default true;
