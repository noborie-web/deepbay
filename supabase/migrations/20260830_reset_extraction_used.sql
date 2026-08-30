-- 月間抽出回数のリセット
--
-- profiles.plan_reset_at は「今月使用した回数(extraction_used)を
-- リセットする日時」として初期スキーマ(001_initial_schema.sql)から
-- 存在していたが、これまで実際にリセットするコードが一切なく、
-- extraction_used が一度も0に戻らず溜まり続けていた
-- (ユーザー報告: 「抽出回数残高はリセットできるようにしてください」)。
--
-- Vercel Hobbyプランのcron制限(1日1回・最大2ジョブまで)により新規の
-- 定期実行cronは追加できないため、抽出リクエスト時・ダッシュボード
-- 表示時に「期限が来ていればリセットする」形で遅延実行する。
CREATE OR REPLACE FUNCTION reset_extraction_used_if_due(user_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE profiles
  SET extraction_used = 0,
      plan_reset_at = date_trunc('month', now()) + interval '1 month',
      updated_at = now()
  WHERE id = user_id
    AND plan_reset_at <= now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
