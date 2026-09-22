-- ユーザー要望: 在庫管理を1日最大4回実行する。
-- Vercel Hobby の cron は1日1回・時刻不定のため、pg_cron + pg_net から
-- 00/06/12/18 UTC(09/15/21/03 JST)に Kakehashi の在庫管理エンドポイントを呼ぶ。
-- 認証キー(CRON_SECRET)は Vault に 'kakehashi_cron_secret' という名前で保存する:
--   select vault.create_secret('<VercelのCRON_SECRET>', 'kakehashi_cron_secret');
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.kakehashi_call_inventory_auto(slot_jst int)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret text;
  request_id bigint;
BEGIN
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'kakehashi_cron_secret' LIMIT 1;
  IF secret IS NULL THEN
    RAISE WARNING 'kakehashi_cron_secret is not set in vault';
    RETURN NULL;
  END IF;
  SELECT net.http_get(
    url := 'https://deepbay.vercel.app/api/cron/inventory-auto?slot=' || slot_jst,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 300000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

-- 既存の同名ジョブがあれば置き換える
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname LIKE 'kakehashi_inventory_auto_%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule('kakehashi_inventory_auto_09', '0 0 * * *',  $$SELECT public.kakehashi_call_inventory_auto(9)$$);
SELECT cron.schedule('kakehashi_inventory_auto_15', '0 6 * * *',  $$SELECT public.kakehashi_call_inventory_auto(15)$$);
SELECT cron.schedule('kakehashi_inventory_auto_21', '0 12 * * *', $$SELECT public.kakehashi_call_inventory_auto(21)$$);
SELECT cron.schedule('kakehashi_inventory_auto_03', '0 18 * * *', $$SELECT public.kakehashi_call_inventory_auto(3)$$);
