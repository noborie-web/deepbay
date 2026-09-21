import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { generateDescriptionsSafely } from '@/lib/translate'

// ユーザー要望: 説明文をAIで生成する(手動実行)。
//  mode=status : 対象件数(scope=missing: 説明文が空の商品 / all: 全商品)
//  mode=run    : 対象を BATCH 件ずつ生成して ebay_description を更新する。
//                UIが残り0件になるまで繰り返し呼ぶ。
// 出品済み(listed)の商品は対象外(eBay上の説明文と食い違わないように)。
export const maxDuration = 60

const BATCH = 40

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface Row {
  id: string
  original_title: string | null
  original_description: string | null
  original_condition: string | null
  ebay_brand: string | null
  ebay_description: string | null
  raw_source_data: Record<string, unknown> | null
  ai_description_generated_at: string | null
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string; scope?: string }
  const mode = body.mode ?? 'status'
  const scope = body.scope === 'all' ? 'all' : 'missing'
  const db = admin()

  let query = db
    .from('products')
    .select('id, original_title, original_description, original_condition, ebay_brand, ebay_description, raw_source_data, ai_description_generated_at')
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .neq('listing_status', 'listed')
    .is('ai_description_generated_at', null)
    .order('created_at', { ascending: true })
  if (scope === 'missing') query = query.or('ebay_description.is.null,ebay_description.eq.')
  const { data: rows, error } = await query.limit(mode === 'run' ? BATCH : 1000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const targets = (rows ?? []) as Row[]

  if (mode === 'status') return NextResponse.json({ ok: true, pending: targets.length })
  if (mode !== 'run') return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: 'OPENAI_API_KEY が設定されていません' }, { status: 500 })
  if (targets.length === 0) return NextResponse.json({ ok: true, processed: 0, failed: 0, pending: 0 })

  const { data: settings } = await db
    .from('extraction_settings')
    .select('description_engine')
    .eq('user_id', user.id)
    .maybeSingle()
  const engine: string = settings?.description_engine ?? 'high'

  const generated = await generateDescriptionsSafely(targets.map(t => {
    const raw = t.raw_source_data ?? {}
    return {
      title: t.original_title ?? '',
      condition: t.original_condition,
      category: typeof raw.category === 'string' ? raw.category : (Array.isArray(raw.categoryPath) ? String(raw.categoryPath[raw.categoryPath.length - 1] ?? '') : null),
      brand: t.ebay_brand ?? (typeof raw.brand === 'string' ? raw.brand : null),
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((h): h is string => typeof h === 'string') : null,
      originalDescription: t.original_description,
    }
  }), engine)

  const now = new Date().toISOString()
  let processed = 0
  let failed = 0
  for (let i = 0; i < targets.length; i++) {
    const g = generated[i]
    if (!g.description) { failed += 1; continue }
    const { error: updateError } = await db
      .from('products')
      .update({ ebay_description: g.description, ai_description_generated_at: now })
      .eq('id', targets[i].id)
      .eq('user_id', user.id)
    if (updateError) failed += 1
    else processed += 1
  }

  // 残件数を数え直す
  let countQuery = db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .neq('listing_status', 'listed')
    .is('ai_description_generated_at', null)
  if (scope === 'missing') countQuery = countQuery.or('ebay_description.is.null,ebay_description.eq.')
  const { count } = await countQuery
  return NextResponse.json({ ok: true, processed, failed, pending: count ?? 0 })
}
