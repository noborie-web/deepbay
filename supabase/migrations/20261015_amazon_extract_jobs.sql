-- ユーザー要望(2026-10-14): Amazon抽出の1回300件という上限を上げたい。
--
-- 300件は計算の結果ぴったりの値で、動かせない:
--   getItemOffersBatch のレート制限 0.1 req/s × 20 ASIN/回 = 実効2 ASIN/s
--   価格取得に割ける時間 150秒 × 2 ASIN/s = 300 ASIN
-- 残り150秒は翻訳・価格計算・保存に使い、全体をVercelの実行時間上限
-- (Hobbyは300秒)に収める必要がある。
--
-- レート制限はアカウント単位なので、どう工夫しても1,000件には約8分半かかる。
-- できるのは「1回の実行時間の壁を超えること」だけなので、ASINを300件ずつの
-- チャンクに分け、複数回の実行にまたがって1つの抽出を仕上げる。
-- その進行状況(どこまで処理したか)を持つのがこのテーブル。
create table if not exists amazon_extract_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  -- 1ジョブ = 1抽出。チャンクをまたいで同じ抽出に商品を足していく
  extraction_id uuid not null references extractions(id) on delete cascade,
  asins text[] not null,
  -- 次に処理する位置。ここまでは処理済みなので、再開しても二重処理にならない
  next_index integer not null default 0,
  chunk_size integer not null default 300,
  fba_only boolean not null default true,
  bulk_edit_setting_id uuid,
  -- pending(未着手) / running(処理中) / completed / failed
  status text not null default 'pending',
  -- チャンクごとの除外内訳を足し合わせたもの(最後に抽出へ書き込む)
  summary jsonb not null default '{}'::jsonb,
  last_error text,
  -- 自動継続が途切れていないかの判断に使う(画面の「続きを実行」)
  last_progress_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1つの抽出に対してジョブは1つ
create unique index if not exists amazon_extract_jobs_extraction_idx
  on amazon_extract_jobs (extraction_id);
-- 未完了のジョブを拾う(画面の「続きを実行」・停滞の検知)
create index if not exists amazon_extract_jobs_user_status_idx
  on amazon_extract_jobs (user_id, status, last_progress_at desc);

alter table amazon_extract_jobs enable row level security;

-- 画面から「未完了のジョブがあるか」を見るため、参照だけ許可する。
-- 更新は service role(サーバー側の処理)だけが行う。
drop policy if exists "amazon_extract_jobs_select_own" on amazon_extract_jobs;
create policy "amazon_extract_jobs_select_own" on amazon_extract_jobs
  for select using (auth.uid() = user_id);
