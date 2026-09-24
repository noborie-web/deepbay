-- ユーザー要望(出品1,000件超への備え)
-- ① メルカリ等(Yahoo!フリマ以外)の仕入先も15分ごとに確認する
-- ② 同期を複数回に分けて実行できるよう、続きの位置を保存する
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS supplier_quick_check_last_at timestamptz;
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS sync_cursor_item_id text;

CREATE OR REPLACE FUNCTION public.kakehashi_call_supplier_quick_check()
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
    url := 'https://deepbay.vercel.app/api/cron/supplier-quick-check',
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 60000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'kakehashi_supplier_quick_check' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 毎時 2/17/32/47 分(フリマチェックの 7/22/37/52 分とずらす)
SELECT cron.schedule('kakehashi_supplier_quick_check', '2,17,32,47 * * * *', $$SELECT public.kakehashi_call_supplier_quick_check()$$);
