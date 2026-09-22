-- ユーザー要望: Yahoo!フリマ商品の売り切れチェックを15分ごとに行う(制限 約15件/15分 に合わせて12件ずつ)
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS flea_check_last_at timestamptz;

CREATE OR REPLACE FUNCTION public.kakehashi_call_flea_check()
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
    url := 'https://deepbay.vercel.app/api/cron/flea-check',
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 60000
  ) INTO request_id;
  RETURN request_id;
END;
$$;

DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'kakehashi_flea_check' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 毎時 7/22/37/52 分(日次の在庫管理 00分 と重ならないようにずらす)
SELECT cron.schedule('kakehashi_flea_check', '7,22,37,52 * * * *', $$SELECT public.kakehashi_call_flea_check()$$);
