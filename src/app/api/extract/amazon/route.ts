import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { parseAsinInput } from '@/lib/amazon-spapi'
import { CHUNK_SIZE, processChunkAndChain } from '@/lib/amazon-job'
import type { Extraction, Profile } from '@/types/database'

export const maxDuration = 300

// ユーザー要望(2026-10-14): 300件という上限を上げたい。
// 1回の実行で処理できるのは300件(2 ASIN/s × 150秒)が限界なので、
// それ以上はASINを300件ずつに分け、複数回の実行にまたがって1つの抽出を
// 仕上げる。レート制限はアカウント単位なので速くはならない
// (1,000件はどうやっても約8分半かかる)。
const MAX_ASINS_PER_RUN = 2000

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
    'reset_extraction_used_if_due', { user_id: user.id },
  )

  const { data: profile } = await supabase
    .from('profiles')
    .select('extraction_limit, extraction_used')
    .eq('id', user.id)
    .single() as { data: Pick<Profile, 'extraction_limit' | 'extraction_used'> | null }
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  if (profile.extraction_used >= profile.extraction_limit) {
    return NextResponse.json(
      { error: '抽出回数の上限に達しました。プランをアップグレードしてください。' },
      { status: 429 },
    )
  }

  const body = await req.json().catch(() => ({})) as {
    asins?: unknown
    categoryId?: unknown
    sellerAccountId?: unknown
    bulkEditSettingId?: unknown
    memo?: unknown
    fbaOnly?: unknown
  }

  if (typeof body.asins !== 'string' || !body.asins.trim()) {
    return NextResponse.json({ error: 'ASINを入力してください' }, { status: 400 })
  }
  const { asins, invalid } = parseAsinInput(body.asins)
  if (asins.length === 0) {
    return NextResponse.json(
      { error: `ASINを読み取れませんでした${invalid.length > 0 ? `（例: ${invalid.slice(0, 3).join(', ')}）` : ''}` },
      { status: 400 },
    )
  }
  if (asins.length > MAX_ASINS_PER_RUN) {
    return NextResponse.json(
      { error: `1回に処理できるのは${MAX_ASINS_PER_RUN}件までです（${asins.length}件が入力されています）。分けて実行してください。` },
      { status: 400 },
    )
  }

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: insertError } = await (supabase as any)
    .from('extractions')
    .insert({
      user_id: user.id,
      // ASIN入力には元URLが無いので、何から作られた抽出か分かる形で残す
      source_url: `amazon:asin-list:${asins.length}`,
      source_site: 'amazon',
      seller_account_id: body.sellerAccountId || null,
      category_id: body.categoryId || null,
      bulk_edit_setting_id: body.bulkEditSettingId || null,
      memo: typeof body.memo === 'string' ? body.memo : '',
      is_bulk: true,
      status: 'processing',
      progress: 0,
    })
    .select()
    .single() as { data: Extraction | null; error: unknown }

  if (insertError || !extraction) {
    const message = insertError instanceof Error ? insertError.message : JSON.stringify(insertError)
    return NextResponse.json({ error: `DB error: ${message}` }, { status: 500 })
  }

  // ユーザー判断(2026-10-13): 無在庫では発送が安定しているFBAを既定にする
  const fbaOnly = body.fbaOnly !== false
  const bulkEditSettingId = typeof body.bulkEditSettingId === 'string' ? body.bulkEditSettingId : null

  const { data: job, error: jobError } = await db
    .from('amazon_extract_jobs')
    .insert({
      user_id: user.id,
      extraction_id: extraction.id,
      asins,
      chunk_size: CHUNK_SIZE,
      fba_only: fbaOnly,
      bulk_edit_setting_id: bulkEditSettingId,
      status: 'pending',
    })
    .select('id')
    .single() as { data: { id: string } | null; error: { message: string } | null }

  if (jobError || !job) {
    await db.from('extractions')
      .update({ status: 'failed', progress: 0, error_message: `抽出ジョブを作成できませんでした: ${jobError?.message ?? '不明なエラー'}` })
      .eq('id', extraction.id)
    return NextResponse.json({ error: `DB error: ${jobError?.message ?? '不明なエラー'}` }, { status: 500 })
  }

  const jobId = job.id
  const extractionId = extraction.id
  const origin = req.nextUrl.origin
  const chunks = Math.ceil(asins.length / CHUNK_SIZE)

  after(async () => {
    await processChunkAndChain(jobId, extractionId, origin)
  })

  return NextResponse.json({
    extractionId,
    jobId,
    asinCount: asins.length,
    chunks,
    // 実効2 ASIN/s(SP-APIのレート制限)から出した目安
    estimatedSec: Math.ceil(asins.length / 2),
    invalid,
  }, { status: 200 })
}
