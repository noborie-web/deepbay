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
    .select('id, ebay_marketplace_id, ebay_policy_cache, ebay_policy_synced_at')
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

  if (!forceRefresh && isFreshCache(seller.ebay_policy_cache, seller.ebay_policy_synced_at)) {
    return NextResponse.json({ ...seller.ebay_policy_cache, cached: true })
  }

  try {
    const refreshToken = decryptEbayRefreshToken(credential.refresh_token_encrypted)
    const accessToken = await refreshEbayAccessToken(refreshToken)
    const policies = await fetchEbayPolicies(
      accessToken,
      seller.ebay_marketplace_id || EBAY_DEFAULT_MARKETPLACE,
    )
    const { error: updateError } = await admin
      .from('seller_accounts')
      .update({
        ebay_policy_cache: policies,
        ebay_policy_synced_at: policies.syncedAt,
      })
      .eq('id', seller.id)
      .eq('user_id', user.id)
    if (updateError) throw new Error(updateError.message)
    return NextResponse.json({ ...policies, cached: false })
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'eBayポリシーの取得に失敗しました'
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 })
  }
}
