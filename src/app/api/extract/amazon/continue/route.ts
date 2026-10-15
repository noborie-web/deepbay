import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { loadJob, processChunkAndChain } from '@/lib/amazon-job'

export const maxDuration = 300

// ユーザー要望(2026-10-14): Amazon抽出の300件上限を上げる。
// 1回の実行では300件(2 ASIN/s × 150秒)が限界なので、チャンクが終わるごとに
// このエンドポイントを呼び直して続きを処理する。
//
// 呼び出し元は2つ:
//   1. 自動継続 … 前のチャンクの処理から Bearer CRON_SECRET で呼ぶ
//   2. 画面の「続きを実行」 … 自動継続が途切れたときに、ログイン中の本人が
//      自分のジョブに対して呼ぶ(途中まで保存した商品は消えない)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { jobId?: unknown }
  if (typeof body.jobId !== 'string' || !body.jobId) {
    return NextResponse.json({ error: 'jobId を指定してください' }, { status: 400 })
  }
  const jobId = body.jobId

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const secret = process.env.CRON_SECRET
  const authorized = Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`

  let job
  try {
    job = await loadJob(db, jobId)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '不明なエラー' }, { status: 500 })
  }
  if (!job) return NextResponse.json({ error: '抽出ジョブが見つかりません' }, { status: 404 })

  // 自動継続でなければ、ログイン中の本人のジョブだけ再開できる
  if (!authorized) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (user.id !== job.user_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (job.status === 'completed') {
    return NextResponse.json({ done: true, nextIndex: job.next_index, total: job.asins.length })
  }

  const extractionId = job.extraction_id
  const origin = req.nextUrl.origin

  after(async () => {
    await processChunkAndChain(jobId, extractionId, origin)
  })

  return NextResponse.json({
    started: true,
    jobId,
    extractionId,
    nextIndex: job.next_index,
    total: job.asins.length,
  })
}
