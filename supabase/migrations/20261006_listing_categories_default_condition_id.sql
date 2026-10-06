-- ユーザー要望(2026-10-06): 商品状態が空だったり、仕入先サイトが想定外の
-- 文字列を返したりすると、変換表にキーが無く既定の 3000 (Used) に落ちる。
-- CD等 3000 を受け付けないカテゴリではアップロードが失敗するため、
-- 「変換表に無い状態のときに使うConditionID」をカテゴリごとに設定できる
-- ようにする。null なら従来どおり 3000。
alter table listing_categories add column if not exists default_condition_id text;

alter table listing_categories drop constraint if exists listing_categories_default_condition_id_check;
alter table listing_categories add constraint listing_categories_default_condition_id_check
  check (default_condition_id is null or default_condition_id in
    ('1000','1500','1750','2000','2500','2750','3000','4000','5000','6000','7000'));
