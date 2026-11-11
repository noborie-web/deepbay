import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { fetchEbayRateLimits, fetchEbayUserRateLimits, type EbayRateLimit } from '@/lib/ebay-rate-limits'

// ユーザー要望(2026-11-11): eBayの実際の呼び出し上限を確認したい。
//
// 本番で確認した不具合(2026-11-08〜09): 同期が「exceeded usage limit on this
// call」で失敗していたが、11/7は3,857回通り11/8は2,238回で拒否されるなど、
// Kakehashiが数えていた回数では説明がつかなかった。
//
// アプリ全体の枠(getRateLimits)を見たところ、Trading APIはどの呼び出しも
// limit 5,000 / count 0 だった。毎日数千回呼んでいるのに0ということは、
// Trading APIの枠は「ユーザー単位」で数えられているということ。
// セラーごとの枠(getUserRateLimits)も合わせて返す。
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Kakehashi が実際に送っている呼び出し。枠の調査で見たいのはこれだけ。
const USED_CALLS = new Set([
  'GetItem',
  'ReviseInventoryStatus',
  'GetMyeBaySelling',
  'GetSellerList',
  'ReviseFixedPriceItem',
])

/** 画面で読みやすいよう、枠の厳しい順に並べる */
function byRemaining(limits: EbayRateLimit[]): EbayRateLimit[] {
  return [...limits].sort((a, b) => a.remaining - b.remaining)
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Kakehashiにログインしていません。ログインしてから開いてください。' },
      { status: 401 },
    )
  }

  const force = req.nextUrl.searchParams.get('refresh') === '1'
  // 全部返すと数百件あって画面では読めない。既定では Kakehashi が実際に使う
  // 呼び出しだけに絞る(?all=1 で全部)。
  const showAll = req.nextUrl.searchParams.get('all') === '1'
  const keep = (limits: EbayRateLimit[]) => byRemaining(
    showAll ? limits : limits.filter(limit => USED_CALLS.has(limit.name)),
  )

  let application: EbayRateLimit[] = []
  let applicationError: string | null = null
  try {
    application = keep(await fetchEbayRateLimits({ force }))
  } catch (error) {
    applicationError = error instanceof Error ? error.message : String(error)
  }

  // セラーごとの枠。Trading APIはこちらで数えられている。
  const db = admin()
  const sellers: Array<{ seller_id: string; limits?: EbayRateLimit[]; error?: string }> = []
  try {
    const { data: settings, error: settingsError } = await db
      .from('inventory_settings')
      .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
      .eq('user_id', user.id)
      .maybeSingle()
    // 握りつぶすと「セラー0件」と区別が付かない(#db-query-safety)
    if (settingsError) throw new Error(settingsError.message)
    const resolver = await createInventoryTokenResolver(db, user.id, settings ?? {})
    for (const account of resolver.accounts) {
      const token = resolver.tokenFor(account.id)
      if (!token) {
        sellers.push({ seller_id: account.seller_id, error: 'eBayに接続されていません' })
        continue
      }
      try {
        sellers.push({ seller_id: account.seller_id, limits: keep(await fetchEbayUserRateLimits(token)) })
      } catch (error) {
        sellers.push({
          seller_id: account.seller_id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } catch (error) {
    sellers.push({ seller_id: '(取得失敗)', error: error instanceof Error ? error.message : String(error) })
  }

  return NextResponse.json({
    ok: true,
    application,
    application_error: applicationError,
    sellers,
    env: {
      EBAY_CLIENT_ID: Boolean((process.env.EBAY_CLIENT_ID ?? '').trim()),
      EBAY_CLIENT_SECRET: Boolean((process.env.EBAY_CLIENT_SECRET ?? '').trim()),
    },
  })
}
