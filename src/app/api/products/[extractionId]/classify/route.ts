import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '@/lib/async-pool'
import { CLASSIFY_CONCURRENCY, CLASSIFY_MODEL, classifyProduct } from '@/lib/product-classify'

// ユーザー要望(2026-10-18): リールのカテゴリに混ざる部品をAIで見分けたい。
// タイトルと1枚目の画像を一度に見せて「本体か部品か」を判定する。
//
// 判定しただけでは何も消さない。結果を products.ai_classification に残し、
// 画面で理由付きの一覧を確認してから削除してもらう(危険単語と同じ流れ)。
// 本番で確認した不具合(2026-10-19): 567件の判定が123件で「Failed to fetch」に
// なった。gpt-5-miniは推論する分だけ遅く、1回100件が60秒に収まらず関数が
// 強制終了していた(1回目と2回目の書き込みの間隔が59秒だった)。
// 他のルート(抽出・在庫同期)と同じ300秒にする。
export const maxDuration = 300

// 1回の呼び出しで判定する件数
const BATCH = 100
// 打ち切りの時刻。これを過ぎたら新しい判定を始めない。
// 進行中の1件は最大40秒(20秒のタイムアウト × 再試行1回)かかるので、
// TIME_BUDGET_MS + 40秒 が maxDuration を超えないようにする
// (240 + 40 = 280 < 300)。超えると応答を返せず「Failed to fetch」になる。
const TIME_BUDGET_MS = 240_000

/** まだ判定が付いていない(または「判断できない」で終わった)件数 */
async function countPending(
  db: ReturnType<typeof admin>, userId: string, extractionId: string,
): Promise<number> {
  const { count } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('extraction_id', extractionId)
    .is('ai_classification', null)
  return count ?? 0
}

/** 前回「判断できない」で終わった件数(拾い直しの案内に使う) */
async function countUnknown(
  db: ReturnType<typeof admin>, userId: string, extractionId: string,
): Promise<number> {
  const { count } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('extraction_id', extractionId)
    .eq('ai_classification->>verdict', 'unknown')
  return count ?? 0
}

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ extractionId: string }> }) {
  const { extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'OpenAIのAPIキーが設定されていません' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({})) as {
    mode?: unknown
    recheck?: unknown
    /** 前回「判断できない」で終わった分だけを拾い直す(明示指定のときだけ) */
    retryUnknown?: unknown
  }
  const db = admin()

  // 判定の基準にするカテゴリ(抽出リスト名。「ダイワ スピニングリール」など)
  const { data: extraction } = await db
    .from('extractions')
    .select('name')
    .eq('id', extractionId)
    .eq('user_id', user.id)
    .maybeSingle()
  const expectedCategory = (extraction?.name as string | null) ?? null

  // 未判定の商品を取る。recheck=true なら判定済みも対象にする
  let query = db
    .from('products')
    .select('id, ebay_title, original_title, ebay_images, original_images')
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  // 既定では未判定のものだけ。判定済み(unknownを含む)は再課金しない。
  //
  // 「判断できない」を自動で retry すると、毎回応答が空になる商品で
  // pending が減らず、画面側の繰り返し呼び出しが終わらなくなる。
  // 拾い直しは retryUnknown を明示したときだけにする。
  if (body.retryUnknown === true) {
    query = query.eq('ai_classification->>verdict', 'unknown')
  } else if (body.recheck !== true) {
    query = query.is('ai_classification', null)
  }
  const { data: rows, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const targets = rows ?? []
  if (body.mode === 'status' || targets.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      pending: await countPending(db, user.id, extractionId),
      unknown: await countUnknown(db, user.id, extractionId),
    })
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const model = CLASSIFY_MODEL
  const startedAt = Date.now()

  const results = await mapWithConcurrency(targets, CLASSIFY_CONCURRENCY, async (row) => {
    // 時間切れの分は判定せず次回に回す(「判定できなかった」として確定させない)
    if (Date.now() - startedAt > TIME_BUDGET_MS) return null
    const images = (row.ebay_images as string[] | null)?.length
      ? (row.ebay_images as string[])
      : ((row.original_images as string[] | null) ?? [])
    const verdict = await classifyProduct(openai, {
      id: row.id as string,
      title: (row.ebay_title as string | null) ?? '',
      originalTitle: (row.original_title as string | null) ?? '',
      // ユーザー案(2026-10-18): 画像は1枚目だけにして費用と時間を抑える
      imageUrl: images[0] ?? null,
    }, { model, expectedCategory })
    return { id: row.id as string, verdict }
  })

  const now = new Date().toISOString()
  // 内訳を返す。全件 unknown のような異常にその場で気づけるようにする
  const counts = { main: 0, part: 0, unknown: 0 }
  let processed = 0
  for (const result of results) {
    if (!result) continue
    const { error: updateError } = await db
      .from('products')
      .update({
        ai_classification: {
          verdict: result.verdict.verdict,
          reason: result.verdict.reason,
          model: result.verdict.model,
          at: now,
        },
      })
      .eq('id', result.id)
      .eq('user_id', user.id)
    if (!updateError) {
      processed += 1
      counts[result.verdict.verdict] += 1
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    pending: await countPending(db, user.id, extractionId),
    unknown: await countUnknown(db, user.id, extractionId),
    model,
    counts,
  })
}
