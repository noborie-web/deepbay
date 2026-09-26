-- ユーザー要望(2026-09-26): 毎回、現在の為替より5円低いレートで出品している
-- (円高リスクへの備え)。手作業をやめて設定として保存し、レート取得時に自動で
-- 差し引く。UK/AUには同じ割合で適用する。
alter table public.price_tier_settings
  add column if not exists rate_adjustment_jpy numeric not null default 0;

alter table public.price_tier_presets
  add column if not exists rate_adjustment_jpy numeric not null default 0;
