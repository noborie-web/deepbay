-- ユーザー要望(2026-10-05): 商品編集画面で ConditionID を直接・一括で
-- 指定したい(2750 / Like New、4000 / Very Good、5000 / Good など)。
-- これまでは商品状態の文字列とカテゴリ別マッピングからの自動判定のみで、
-- 個別の商品にConditionIDを直接割り当てる手段がなかった。
-- null のときは従来どおり自動判定する。
alter table products add column if not exists ebay_condition_id text;

alter table products drop constraint if exists products_ebay_condition_id_check;
alter table products add constraint products_ebay_condition_id_check
  check (ebay_condition_id is null or ebay_condition_id in
    ('1000','1500','1750','2000','2500','2750','3000','4000','5000','6000','7000'));
