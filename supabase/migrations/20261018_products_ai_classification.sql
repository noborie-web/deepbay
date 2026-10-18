-- ユーザー要望(2026-10-18): リールのカテゴリにスプール・ハンドル等の部品が
-- 混ざる。タイトルと1枚目の画像をAIに見せて「本体か部品か」を判定する。
-- 判定結果を残して、画面を開き直しても再課金せずに見られるようにする。
-- { verdict: 'main'|'part'|'unknown', reason: string, model: string, at: string }
alter table products add column if not exists ai_classification jsonb;
