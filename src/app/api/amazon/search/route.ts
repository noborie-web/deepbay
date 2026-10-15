import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { loadAmazonCredentials } from '@/lib/amazon-credentials'
import { AmazonAuthError, fetchAccessToken } from '@/lib/amazon-spapi'
import { AmazonSearchError, parseAmazonSearchQuery, searchAmazonAsins } from '@/lib/amazon-search'

// ユーザー要望(2026-10-12): 仕入先としてのAmazon、段階2。
// Amazonの検索URL・キーワードからASIN一覧を作る。
//
// ここでは抽出を始めない。SP-APIの検索結果はAmazon.co.jpの検索結果と
// 一致しないため、取れたASINを画面で見てから選んで抽出に渡す
// (抽出回数を消費する前に中身を確認できるようにする)。
export const maxDuration = 60

// 1回の検索で返す件数の上限。
// searchCatalogItems は1ページ20件・2 req/s なので 40 ASIN/秒。
// 1,000件なら50ページ=約25秒で、下の時間予算(45秒)に収まる。
const MAX_LIMIT = 1000
// SP-APIの検索に使う時間。maxDuration(60秒)より手前で打ち切る
const SEARCH_BUDGET_MS = 45_000

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { query?: unknown; limit?: unknown }
  if (typeof body.query !== 'string' || !body.query.trim()) {
    return NextResponse.json({ error: '検索URLまたはキーワードを入力してください' }, { status: 400 })
  }

  const parsed = parseAmazonSearchQuery(body.query)
  if (parsed.keywords.length === 0) {
    return NextResponse.json(
      {
        error: parsed.warnings[0]
          ?? 'キーワードを読み取れませんでした。Amazonの検索URL（k=...）かキーワードを入力してください',
        warnings: parsed.warnings,
      },
      { status: 400 },
    )
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(Number(body.limit)) ? Math.floor(Number(body.limit)) : 100),
  )

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  try {
    const credentials = await loadAmazonCredentials(db, user.id)
    if (!credentials) {
      return NextResponse.json(
        { error: 'Amazonと接続されていません。抽出設定 → 仕入先連携で接続してください' },
        { status: 400 },
      )
    }

    const { accessToken } = await fetchAccessToken(credentials)
    const result = await searchAmazonAsins(accessToken, parsed, {
      limit,
      marketplaceId: credentials.marketplaceId,
      timeBudgetMs: SEARCH_BUDGET_MS,
    })

    return NextResponse.json({
      items: result.items,
      count: result.items.length,
      truncated: result.truncated,
      requests: result.requests,
      query: {
        keywords: parsed.keywords,
        brandNames: parsed.brandNames,
        classificationIds: parsed.classificationIds,
      },
      warnings: parsed.warnings,
    })
  } catch (error) {
    if (error instanceof AmazonAuthError || error instanceof AmazonSearchError) {
      return NextResponse.json({ error: error.message, warnings: parsed.warnings }, { status: 400 })
    }
    const message = error instanceof Error ? error.message : '不明なエラー'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
