import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  EBAY_DEFAULT_MARKETPLACE,
  decryptEbayRefreshToken,
  fetchEbayPolicies,
  refreshEbayAccessToken,
  type EbayPolicySet,
} from '@/lib/ebay'
import { marketplaceIdForSite, normalizeSiteKeys } from '@/lib/ebay-sites'

// ユーザー報告(2026-10-19): akebono-32 は UK/AU に出品する設定なのに、
// ポリシーをセラーの marketplaceId(EBAY_AU)だけで取っていたため、
// UK向けのポリシーが選択肢に出てこなかった。
// ビジネスポリシーはマーケットプレイスごとに別物なので、その出品アカウントが
// 出品する全サイトぶんを取ってサイト別に返す。

const CACHE_TTL_MS = 15 * 60 * 1000

function isFreshCache(value: unknown, syncedAt: unknown): value is EbayPolicySet {
  if (!value || typeof value !== 'object' || typeof syncedAt !== 'string') return false
  const age = Date.now() - new Date(syncedAt).getTime()
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sellerAccountId = request.nextUrl.searchParams.get('sellerAccountId')
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1'
  if (!sellerAccountId) {
    return NextResponse.json({ error: 'sellerAccountId が必要です' }, { status: 400 })
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: seller, error } = await admin
    .from('seller_accounts')
    .select('id, ebay_marketplace_id, listing_site_ids, ebay_policy_cache, ebay_policy_synced_at')
    .eq('id', sellerAccountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!seller) return NextResponse.json({ error: 'eBayセラーが見つかりません' }, { status: 404 })

  const { data: credential, error: credentialError } = await admin
    .from('ebay_account_credentials')
    .select('refresh_token_encrypted')
    .eq('seller_account_id', seller.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (credentialError) return NextResponse.json({ error: credentialError.message }, { status: 500 })
  if (!credential?.refresh_token_encrypted) {
    return NextResponse.json({ error: 'このセラーはeBayに接続されていません', connected: false }, { status: 409 })
  }

  // このセラーが出品するサイト(例: akebono-32 は UK/AU)
  const siteKeys = normalizeSiteKeys((seller.listing_site_ids as string[] | null)?.join(','))
  // 画面が従来どおり単一のポリシー集合も読めるよう、既定サイトを決める
  const primarySite = siteKeys.find(
    (key) => marketplaceIdForSite(key) === (seller.ebay_marketplace_id || EBAY_DEFAULT_MARKETPLACE),
  ) ?? siteKeys[0]

  const cache = seller.ebay_policy_cache as Record<string, unknown> | null
  const cachedBySite = (cache?.bySite ?? null) as Record<string, EbayPolicySet> | null
  // サイトが増えた直後は、古いキャッシュに無いサイトがあるので取り直す
  const cacheCoversAllSites = cachedBySite
    ? siteKeys.every((key) => cachedBySite[key])
    : false

  if (!forceRefresh && cacheCoversAllSites && isFreshCache(cache, seller.ebay_policy_synced_at)) {
    return NextResponse.json({ ...buildResponse(cachedBySite!, siteKeys, primarySite), cached: true })
  }

  try {
    const refreshToken = decryptEbayRefreshToken(credential.refresh_token_encrypted)
    const accessToken = await refreshEbayAccessToken(refreshToken)

    // サイトごとに取る。1サイトが失敗しても他のサイトは使えるようにする
    const entries = await Promise.all(siteKeys.map(async (key) => {
      try {
        return [key, await fetchEbayPolicies(accessToken, marketplaceIdForSite(key))] as const
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : '取得に失敗しました'
        return [key, { error: message.slice(0, 300) }] as const
      }
    }))

    const bySite: Record<string, EbayPolicySet> = {}
    const siteErrors: Record<string, string> = {}
    for (const [key, value] of entries) {
      if ('error' in value) siteErrors[key] = value.error
      else bySite[key] = value
    }

    if (Object.keys(bySite).length === 0) {
      const first = Object.values(siteErrors)[0] ?? 'eBayポリシーの取得に失敗しました'
      return NextResponse.json({ error: first }, { status: 502 })
    }

    const syncedAt = new Date().toISOString()
    const { error: updateError } = await admin
      .from('seller_accounts')
      .update({
        ebay_policy_cache: { bySite, syncedAt },
        ebay_policy_synced_at: syncedAt,
      })
      .eq('id', seller.id)
      .eq('user_id', user.id)
    if (updateError) throw new Error(updateError.message)

    return NextResponse.json({
      ...buildResponse(bySite, siteKeys, primarySite),
      siteErrors: Object.keys(siteErrors).length > 0 ? siteErrors : undefined,
      cached: false,
    })
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'eBayポリシーの取得に失敗しました'
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 })
  }
}

/**
 * サイト別の集合を返しつつ、従来の形(単一サイトのポリシー)も残す。
 * 画面の古い読み方を壊さないため。
 */
function buildResponse(
  bySite: Record<string, EbayPolicySet>,
  siteKeys: string[],
  primarySite: string,
) {
  const primary = bySite[primarySite] ?? Object.values(bySite)[0]
  return {
    ...primary,
    sites: siteKeys,
    primarySite,
    bySite,
  }
}
