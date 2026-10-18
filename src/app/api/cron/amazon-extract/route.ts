import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { processChunkAndChain } from '@/lib/amazon-job'

// ユーザー要望(2026-10-18): Amazon抽出の分割実行を定期実行(pg_cron)で進める。
//
// #282 では「Vercel Hobbyのcronは1日1回しか動かせない」として、チャンクが
// 終わるごとに自分の継続エンドポイントを呼び直す方式にした。しかしその後、
// 定期実行は Supabase の pg_cron から叩かれていることが分かった
// (vercel.json の1日1回とは別に、15分間隔のジョブが動いている)。
// 自己呼び出しは1回でも失敗するとそこで止まるが、定期実行なら次の回で
// 必ず拾い直せる。
//
// 自己呼び出しは残してある(速いため)。このcronは取りこぼしの保険として、
// 止まっているジョブを進める。
export const maxDuration = 300

// 自己呼び出しが途切れたとみなすまでの時間。1チャンクは最長270秒なので、
// その2倍を見ておく(動いているジョブを二重に走らせない)。
const STALLED_AFTER_MS = 10 * 60 * 1000

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const stalledBefore = new Date(Date.now() - STALLED_AFTER_MS).toISOString()

  // 未完了で、しばらく進んでいないジョブを1つだけ進める(実行時間に収めるため)
  const { data: jobs, error } = await db
    .from('amazon_extract_jobs')
    .select('id, extraction_id, next_index, status')
    .in('status', ['pending', 'running'])
    .lt('last_progress_at', stalledBefore)
    .order('last_progress_at', { ascending: true })
    .limit(1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const job = (jobs ?? [])[0] as { id: string; extraction_id: string; next_index: number } | undefined
  if (!job) {
    return NextResponse.json({ ok: true, resumed: null, message: '止まっているAmazon抽出はありません' })
  }

  await processChunkAndChain(job.id, job.extraction_id, req.nextUrl.origin)

  return NextResponse.json({
    ok: true,
    resumed: { job_id: job.id, extraction_id: job.extraction_id, from_index: job.next_index },
  })
}
