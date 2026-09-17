import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Product } from '@/types/database'
import { translateDescription } from '@/lib/translate'
import { listingDescription } from '@/lib/listing-export'
import { reviseDescription } from '@/lib/ebay-actions'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { loadActiveHtmlTemplate } from '@/lib/html-template'
import { checkTranslatedDescription, hasJapaneseDescription } from '@/lib/description-translation'

// ユーザー要望: 出品済み商品(148件)の説明文が日本語のままなので、英訳して
// eBayの説明文を差し替える。
//  mode=preview : 数件を翻訳して before/after を返す(保存しない)
//  mode=translate: 日本語の説明文を持つ商品を limit 件ずつ翻訳して保存
//  mode=revise   : 翻訳済みで未反映の出品を limit 件ずつ ReviseItem で差し替え
//  mode=status   : 件数だけ返す
// Vercel の実行時間上限に収まるよう、1リクエストで処理する件数を絞り、
// 画面側で繰り返し呼ぶ。
export const maxDuration = 300

const TRANSLATE_LIMIT_MAX = 25
const REVISE_LIMIT_MAX = 30

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

async function loadListedProducts(db: ReturnType<typeof admin>, userId: string) {
  const { data, error } = await db
    .from('products')
    .select('id, ebay_item_id, ebay_title, original_title, ebay_description, original_description, ebay_condition, original_condition, listing_status, description_synced_at')
    .eq('user_id', userId)
    .in('listing_status', ['listed', 'delisted', 'sold'])
    .not('ebay_item_id', 'is', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<Pick<Product, 'id' | 'ebay_item_id' | 'ebay_title' | 'original_title' | 'ebay_description' | 'original_description' | 'ebay_condition' | 'original_condition' | 'listing_status' | 'description_synced_at'>>
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string; limit?: number; engine?: string }
  const mode = body.mode ?? 'status'
  const db = admin()

  const { data: settings } = await db
    .from('extraction_settings')
    .select('description_engine')
    .eq('user_id', user.id)
    .maybeSingle()
  const engine = body.engine ?? settings?.description_engine ?? 'high'

  let products: Awaited<ReturnType<typeof loadListedProducts>>
  try {
    products = await loadListedProducts(db, user.id)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
  const untranslated = products.filter(hasJapaneseDescription)
  const translatedUnsynced = products.filter(p => !hasJapaneseDescription(p) && !p.description_synced_at && p.listing_status === 'listed')
  const status = {
    total: products.length,
    untranslated: untranslated.length,
    translated: products.length - untranslated.length,
    unsynced: translatedUnsynced.length,
  }

  if (mode === 'status') return NextResponse.json({ ok: true, status })

  if (!process.env.OPENAI_API_KEY && mode !== 'revise') {
    return NextResponse.json({ error: '翻訳APIキー(OPENAI_API_KEY)が設定されていません' }, { status: 500 })
  }

  if (mode === 'preview') {
    const limit = Math.min(Math.max(1, Math.floor(body.limit ?? 3)), 5)
    const samples = []
    for (const product of untranslated.slice(0, limit)) {
      const before = product.ebay_description ?? product.original_description ?? ''
      try {
        const after = await translateDescription(before, engine)
        samples.push({ id: product.id, ebay_item_id: product.ebay_item_id, title: product.ebay_title ?? product.original_title, before, after })
      } catch (error) {
        samples.push({ id: product.id, ebay_item_id: product.ebay_item_id, title: product.ebay_title ?? product.original_title, before, after: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return NextResponse.json({ ok: true, status, samples })
  }

  if (mode === 'translate') {
    const limit = Math.min(Math.max(1, Math.floor(body.limit ?? TRANSLATE_LIMIT_MAX)), TRANSLATE_LIMIT_MAX)
    const targets = untranslated.slice(0, limit)
    let translated = 0
    const failed: Array<{ id: string; error: string }> = []
    const concurrency = 5
    let index = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (index < targets.length) {
        const product = targets[index++]
        const source = product.original_description ?? product.ebay_description ?? ''
        try {
          const after = await translateDescription(source, engine)
          const check = checkTranslatedDescription(after)
          if (!check.ok) throw new Error(check.reason)
          const { error } = await db
            .from('products')
            .update({ ebay_description: after, description_synced_at: null, updated_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .eq('id', product.id)
          if (error) throw new Error(error.message)
          translated += 1
        } catch (error) {
          failed.push({ id: product.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }))
    return NextResponse.json({
      ok: true,
      translated,
      failed,
      remaining: Math.max(0, untranslated.length - translated - failed.length),
      done: untranslated.length - translated - failed.length <= 0,
    })
  }

  if (mode === 'revise') {
    const limit = Math.min(Math.max(1, Math.floor(body.limit ?? REVISE_LIMIT_MAX)), REVISE_LIMIT_MAX)
    const targets = translatedUnsynced.slice(0, limit)
    if (targets.length === 0) return NextResponse.json({ ok: true, revised: 0, failed: [], remaining: 0, done: true })

    const { data: inventorySettings } = await db
      .from('inventory_settings')
      .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
      .eq('user_id', user.id)
      .maybeSingle()
    let accessToken: string
    try {
      accessToken = await resolveInventoryAccessToken(db, user.id, inventorySettings ?? {})
    } catch (error) {
      return NextResponse.json({ error: `eBayトークンの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 })
    }

    const htmlTemplate = await loadActiveHtmlTemplate(db, user.id)
    const results = []
    for (const product of targets) {
      const html = listingDescription(product as Product, htmlTemplate)
      const result = await reviseDescription(accessToken, product.ebay_item_id!, html)
      results.push(result)
      if (result.success) {
        await db
          .from('products')
          .update({ description_synced_at: new Date().toISOString() })
          .eq('user_id', user.id)
          .eq('id', product.id)
      }
    }
    const succeeded = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).map(r => ({ id: r.itemId, error: r.error }))
    const summary = summarizeInventoryActionRun(results)
    await db.from('inventory_runs').insert({
      user_id: user.id,
      run_type: 'revise_description',
      status: summary.status,
      error_message: summary.errorMessage,
      result_summary: { total: results.length, succeeded, failed },
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    })
    const remaining = Math.max(0, translatedUnsynced.length - succeeded - failed.length)
    return NextResponse.json({ ok: true, revised: succeeded, failed, remaining, done: remaining <= 0 })
  }

  return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })
}
