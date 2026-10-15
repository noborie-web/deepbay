-- ユーザー要望(2026-10-15): 商品ページからの補完が残っているかを、抽出結果を
-- 開かなくても抽出一覧で分かるようにしたい。
--
-- 一覧は最大50件の抽出を表示する。各抽出の未補完件数を数えるのに products を
-- そのまま取ってくると数千行になり、PostgRESTの既定の行上限(1000)で黙って
-- 打ち切られて誤った件数を出しかねない。件数はDB側で数える。
--
-- 対象サイトは呼び出し側(src/lib/enrich-sites.ts)から渡す。SQLに直接書くと
-- 補完API側の対象と食い違っても気づけないため。
create or replace function extraction_enrich_pending(
  p_user_id uuid,
  p_extraction_ids uuid[],
  p_sites text[]
)
returns table (extraction_id uuid, pending bigint, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.extraction_id,
    count(*) filter (where p.detail_enriched_at is null) as pending,
    count(*) as total
  from products p
  where p.user_id = p_user_id
    and p.extraction_id = any(p_extraction_ids)
    and p.source_site = any(p_sites)
  group by p.extraction_id
$$;
