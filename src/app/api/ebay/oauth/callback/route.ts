import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  EBAY_DEFAULT_MARKETPLACE,
  EBAY_OAUTH_SCOPES,
  encryptEbayRefreshToken,
  exchangeEbayAuthorizationCode,
  getEbayIdentity,
} from '@/lib/ebay'

function redirectWithMessage(
  request: NextRequest,
  returnTo: string,
  key: 'ebayConnected' | 'ebayError',
  value: string,
) {
  const target = new URL(returnTo, request.nextUrl.origin)
  target.searchParams.set(key, value)
  const response = NextResponse.redirect(target)
  response.cookies.delete('ebay_oauth_state')
  response.cookies.delete('ebay_oauth_return_to')
  response.cookies.delete('ebay_oauth_seller_account_id')
  return response
}

export async function GET(request: NextRequest) {
  const returnTo = request.cookies.get('ebay_oauth_return_to')?.value ?? '/extraction'
  const targetSellerAccountId = request.cookies.get('ebay_oauth_seller_account_id')?.value
  const expectedState = request.cookies.get('ebay_oauth_state')?.value
  const state = request.nextUrl.searchParams.get('state')
  const code = request.nextUrl.searchParams.get('code')
  const denied = request.nextUrl.searchParams.get('error')

  if (denied) {
    return redirectWithMessage(request, returnTo, 'ebayError', 'eBay接続がキャンセルされました')
  }
  if (!expectedState || !state || state !== expectedState || !code) {
    return redirectWithMessage(request, returnTo, 'ebayError', 'eBay接続の検証に失敗しました')
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return redirectWithMessage(request, '/login', 'ebayError', 'DeepBayへ再ログインしてください')
  }

  try {
    const token = await exchangeEbayAuthorizationCode(code)
    if (!token.refresh_token) throw new Error('eBayから更新トークンが返されませんでした')
    const identity = await getEbayIdentity(token.access_token!)
    const marketplaceId = identity.registrationMarketplaceId || EBAY_DEFAULT_MARKETPLACE
    const encryptedRefreshToken = encryptEbayRefreshToken(token.refresh_token)
    const admin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { data: targetSeller } = targetSellerAccountId
      ? await admin
        .from('seller_accounts')
        .select('id, seller_id, display_name')
        .eq('id', targetSellerAccountId)
        .eq('user_id', user.id)
        .maybeSingle()
      : { data: null }
    const sellerId = identity.username || targetSeller?.seller_id || identity.userId
    const { data: byUserId } = targetSeller
      ? { data: null }
      : await admin
        .from('seller_accounts')
        .select('id')
        .eq('user_id', user.id)
        .eq('ebay_user_id', identity.userId)
        .maybeSingle()
    const { data: bySellerId } = targetSeller || byUserId
      ? { data: null }
      : await admin
        .from('seller_accounts')
        .select('id')
        .eq('user_id', user.id)
        .eq('seller_id', sellerId)
        .maybeSingle()
    const existingId = targetSeller?.id ?? byUserId?.id ?? bySellerId?.id
    const values = {
      user_id: user.id,
      seller_id: sellerId,
      display_name: targetSeller?.display_name || sellerId,
      ebay_user_id: identity.userId,
      ebay_marketplace_id: marketplaceId,
      ebay_connected_at: new Date().toISOString(),
      ebay_policy_cache: null,
      ebay_policy_synced_at: null,
    }
    const result = existingId
      ? await admin
        .from('seller_accounts')
        .update(values)
        .eq('id', existingId)
        .eq('user_id', user.id)
        .select('id')
        .single()
      : await admin.from('seller_accounts').insert(values).select('id').single()
    if (result.error) throw new Error(result.error.message)
    const sellerAccountId = result.data.id
    const { error: credentialError } = await admin
      .from('ebay_account_credentials')
      .upsert({
        seller_account_id: sellerAccountId,
        user_id: user.id,
        refresh_token_encrypted: encryptedRefreshToken,
        token_scopes: token.scope?.split(' ').filter(Boolean) ?? [...EBAY_OAUTH_SCOPES],
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'seller_account_id' })
    if (credentialError) throw new Error(credentialError.message)

    return redirectWithMessage(request, returnTo, 'ebayConnected', sellerId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'eBay接続に失敗しました'
    return redirectWithMessage(request, returnTo, 'ebayError', message.slice(0, 300))
  }
}
