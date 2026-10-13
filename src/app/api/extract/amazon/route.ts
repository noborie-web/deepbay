import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { runScrape } from '@/lib/extraction-run'
import { fetchAmazonProducts } from '@/lib/amazon-extract'
import { parseAsinInput } from '@/lib/amazon-spapi'
import type { Extraction, Profile } from '@/types/database'

export const maxDuration = 300

// 実行時間の上限(300秒)より手前で打ち切り、「処理中」のまま残さない(#255と同じ)
const EXTRACTION_DEADLINE_MS = 270_000
// SP-APIの取得に使う時間。残りは翻訳・価格計算・保存に回す
const AMAZON_FETCH_BUDGET_MS = 150_000
// 1回で扱えるASIN数。実効2 ASIN/s なので、これ以上は時間内に終わらない
const MAX_ASINS_PER_RUN = 300

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

  const extractionId = extraction.id
  const userId = user.id
  // ユーザー判断(2026-10-13): 無在庫では発送が安定しているFBAを既定にする
  // (抽出時に切り替えられる)
  const fbaOnly = body.fbaOnly !== false
  const bulkEditSettingId = typeof body.bulkEditSettingId === 'string' ? body.bulkEditSettingId : null

  after(async () => {
    const bg = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    let finished = false
    const timeout = setTimeout(() => {
      if (finished) return
      void bg
        .from('extractions')
        .update({
          status: 'failed',
          progress: 0,
          error_message: '抽出が時間内に完了しませんでした（実行時間の上限）。ASINの件数を減らして再実行してください。',
        })
        .eq('id', extractionId)
        .eq('status', 'processing')
        .then(({ error }) => { if (error) console.warn('[extract/amazon] failed to mark timeout:', error.message) })
    }, EXTRACTION_DEADLINE_MS)

    try {
      const fetched = await fetchAmazonProducts(bg, userId, asins, {
        timeBudgetMs: AMAZON_FETCH_BUDGET_MS,
        fbaOnly,
      })

      if (fetched.products.length === 0) {
        await bg.from('extractions').update({
          status: 'failed',
          progress: 0,
          error_message: amazonEmptyReason(fetched),
        }).eq('id', extractionId)
        return
      }

      await runScrape(userId, extractionId, `amazon:asin-list:${asins.length}`, bulkEditSettingId, bg, {
        deadlineAt: Date.now() + (EXTRACTION_DEADLINE_MS - AMAZON_FETCH_BUDGET_MS),
        presetProducts: fetched.products,
      })
    } catch (error) {
      const message = (error instanceof Error ? error.message : '不明なエラー').slice(0, 500)
      await bg.from('extractions').update({
        status: 'failed', progress: 0, error_message: message,
      }).eq('id', extractionId)
    } finally {
      finished = true
      clearTimeout(timeout)
    }
  })

  return NextResponse.json({ extractionId, asinCount: asins.length, invalid }, { status: 200 })
}

function amazonEmptyReason(fetched: {
  pricingFailed: string[]
  noOffer: string[]
  skipped: string[]
}): string {
  const parts: string[] = []
  if (fetched.noOffer.length > 0) parts.push(`新品の出品が無い: ${fetched.noOffer.length}件`)
  if (fetched.pricingFailed.length > 0) parts.push(`価格を取得できなかった: ${fetched.pricingFailed.length}件（再実行で取得できることがあります）`)
  if (fetched.skipped.length > 0) parts.push(`時間切れで未処理: ${fetched.skipped.length}件`)
  return `取り込める商品がありませんでした。${parts.join(' / ')}`
}
