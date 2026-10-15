import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { countPending, runEnrichDetailsBatch } from '@/lib/enrich-details'

// ユーザー要望: ヤフオク・Yahoo!フリマの抽出で「必要なものは取得できるように」。
// 抽出中に商品ページを並行取得するとYahoo!フリマから429で拒否されるため、
// 抽出完了後にこのAPIで少しずつ補完する。画面は残り0件になるまで繰り返し呼ぶ。
//  mode=status : 未補完の件数
//  mode=run    : 未補完の商品を補完する(説明文は抽出設定に従って英訳)
//
// 処理の中身は lib/enrich-details に共通化していて、定期実行
// (/api/cron/enrich-details)からも同じ処理を呼ぶ。画面を開いていなくても
// 補完が進むようにするため。
export const maxDuration = 60

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string }
  const mode = body.mode ?? 'status'
  const db = admin()

  if (mode === 'status') {
    return NextResponse.json({ ok: true, pending: await countPending(db, user.id, extractionId) })
  }
  if (mode !== 'run') return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })

  try {
    const result = await runEnrichDetailsBatch(db, user, extractionId)
    return NextResponse.json({
      ok: true,
      processed: result.processed,
      failed: result.failed,
      pending: result.pending,
      flea_pending: result.fleaPending,
      retry_after_ms: result.retryAfterMs,
      flea_rate_limited: result.fleaRateLimited,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '不明なエラー' }, { status: 500 })
  }
}
