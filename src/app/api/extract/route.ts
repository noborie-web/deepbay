import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { findScraper } from '@/lib/scrapers'
import { runScrape } from '@/lib/extraction-run'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Extraction, Profile } from '@/types/database'

export const maxDuration = 300

// 実行時間の上限(300秒)より手前で打ち切り、「処理中」のまま残さない
const EXTRACTION_DEADLINE_MS = 270_000

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 月間リセット期限(plan_reset_at)が過ぎていれば抽出回数を0に戻す。
  // 専用cronは追加できない(Vercel Hobbyプランの制限)ため、抽出実行時に
  // 遅延実行する。生成済みのDatabase型にFunctions定義がなくrpc()の型が
  // 合わないため、既存のincrement_extraction_used呼び出し(extraction-run.ts)
  // と同様にキャストして呼び出す。
  await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
    'reset_extraction_used_if_due', { user_id: user.id },
  )

  // 抽出回数チェック
  const { data: profile } = await supabase
    .from('profiles')
    .select('extraction_limit, extraction_used')
    .eq('id', user.id)
    .single() as { data: Pick<Profile, 'extraction_limit' | 'extraction_used'> | null }

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  if (profile.extraction_used >= profile.extraction_limit) {
    return NextResponse.json(
      { error: '抽出回数の上限に達しました。プランをアップグレードしてください。' },
      { status: 429 },
    )
  }

  const body = await req.json()
  const { url, categoryId, sellerAccountId, bulkEditSettingId, memo, isBulk } = body

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URLが必要です' }, { status: 400 })
  }

  const scraper = findScraper(url)
  if (!scraper) {
    return NextResponse.json(
      { error: 'このURLには対応していません。対応サイト: メルカリ、ヤフオク、ラクマ、スニーカーダンク' },
      { status: 400 },
    )
  }

  // 抽出ジョブをDBに登録
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: insertError } = await (supabase as any)
    .from('extractions')
    .insert({
      user_id: user.id,
      source_url: url,
      source_site: scraper.siteKey,
      seller_account_id: sellerAccountId || null,
      category_id: categoryId || null,
      bulk_edit_setting_id: bulkEditSettingId || null,
      memo: memo ?? '',
      is_bulk: isBulk ?? false,
      status: 'processing',
      progress: 0,
    })
    .select()
    .single() as { data: Extraction | null; error: unknown }

  if (insertError || !extraction) {
    const msg = insertError instanceof Error ? insertError.message : JSON.stringify(insertError)
    console.error('Extract insert error:', msg)
    return NextResponse.json({ error: `DB error: ${msg}` }, { status: 500 })
  }

  const extractionId = extraction.id
  const userId = user.id

  // レスポンス返却後にバックグラウンドでスクレイピング実行
  after(async () => {
    // service role clientで認証不要のDB操作
    const bg = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    // 本番で確認した不具合(2026-10-03): 抽出が90%のまま1時間以上「処理中」で
    // 止まり、商品も0件だった。実行時間の上限(300秒)で強制終了されると
    // catchも走らないため、失敗として記録されず画面が回り続ける。
    // 上限より手前で自分から打ち切り、理由を残す。
    let finished = false
    const timeout = setTimeout(() => {
      if (finished) return
      void bg
        .from('extractions')
        .update({
          status: 'failed',
          progress: 0,
          error_message: '抽出が時間内に完了しませんでした（実行時間の上限）。抽出件数を減らすか、条件を絞って再実行してください。',
        })
        .eq('id', extractionId)
        .eq('status', 'processing')
        .then(({ error }) => {
          if (error) console.warn('[extract] failed to mark timeout:', error.message)
        })
    }, EXTRACTION_DEADLINE_MS)
    try {
      // 上限時間の手前で、AI処理を切り上げて「取得できた分を保存して完了」
      // させるための期限。setTimeoutの打ち切り(失敗記録)はあくまで保険。
      await runScrape(userId, extractionId, url, bulkEditSettingId || null, bg, {
        deadlineAt: Date.now() + EXTRACTION_DEADLINE_MS,
      })
    } finally {
      finished = true
      clearTimeout(timeout)
    }
  })

  return NextResponse.json({ extractionId }, { status: 200 })
}
