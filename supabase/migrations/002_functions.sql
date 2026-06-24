-- 抽出回数をインクリメントするRPC
CREATE OR REPLACE FUNCTION increment_extraction_used(user_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE profiles
  SET extraction_used = extraction_used + 1,
      updated_at = now()
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
