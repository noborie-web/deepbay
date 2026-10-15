import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { runEnrichDetailsBatch } from '@/lib/enrich-details'
import { ENRICHABLE_SITES } from '@/lib/enrich-sites'

// ユーザー要望(2026-10-15): 抽出結果のページを開かなくても、説明文・画像の
// 補完が進むようにしたい。従来は画面がこのAPIを繰り返し呼ぶ作りだったため、
// ページを閉じると止まっていた。
//
// 1回の呼び出しで、未補完の商品がいちばん古い抽出を1つだけ進める
// (1回あたり最大30件・約45秒)。仕入先のアクセス制限に合わせた間隔は
// lib/enrich-details 側で守られる。
export const maxDuration = 60

// 1回の呼び出しで進める抽出の数。実行時間(60秒)に収めるため1つだけ。
const EXTRACTIONS_PER_RUN = 1

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const nowIso = new Date().toISOString()

  // 補完待ちで、いま試せる(再試行待ちでない)商品を古い順に拾う。
  // そこから抽出を1つ選んで進める。
  const { data: rows, error } = await db
    .from('products')
    .select('user_id, extraction_id')
    .in('source_site', [...ENRICHABLE_SITES])
    .is('detail_enriched_at', null)
    .or(`detail_retry_after.is.null,detail_retry_after.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const seen = new Set<string>()
  const targets: Array<{ userId: string; extractionId: string }> = []
  for (const row of rows ?? []) {
    const userId = row.user_id as string | null
    const extractionId = row.extraction_id as string | null
    if (!userId || !extractionId) continue
    const key = `${userId}:${extractionId}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ userId, extractionId })
    if (targets.length >= EXTRACTIONS_PER_RUN) break
  }

  if (targets.length === 0) {
    return NextResponse.json({ ok: true, results: [], message: '補完待ちの商品はありません' })
  }

  const results = []
  for (const target of targets) {
    try {
      const result = await runEnrichDetailsBatch(db, { id: target.userId }, target.extractionId)
      results.push({ extraction_id: target.extractionId, ...result })
    } catch (err) {
      const message = err instanceof Error ? err.message : '不明なエラー'
      console.error('[cron/enrich-details] failed for', target.extractionId, message)
      results.push({ extraction_id: target.extractionId, error: message })
    }
  }

  return NextResponse.json({ ok: true, results })
}
