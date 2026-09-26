-- ユーザー要望(2026-09-26): 関税率13%は米国向けの設定なので、UK/AU出品では
-- 適用しないようにしたい。価格設定に切り替えを1つ持たせる(既定はON=適用しない)。
alter table public.price_tier_settings
  add column if not exists skip_customs_outside_us boolean not null default true;

alter table public.price_tier_presets
  add column if not exists skip_customs_outside_us boolean not null default true;
