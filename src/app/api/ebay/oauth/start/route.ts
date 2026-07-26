import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildEbayConsentUrl } from '@/lib/ebay'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const state = randomUUID()
    const returnToParam = request.nextUrl.searchParams.get('returnTo') ?? '/extraction'
    const returnTo = returnToParam.startsWith('/') && !returnToParam.startsWith('//')
      ? returnToParam
      : '/extraction'
    const sellerAccountId = request.nextUrl.searchParams.get('sellerAccountId')
    if (sellerAccountId) {
      const { data: seller, error } = await supabase
        .from('seller_accounts')
        .select('id')
        .eq('id', sellerAccountId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!seller) throw new Error('接続対象のeBayセラーが見つかりません')
    }
    const response = NextResponse.redirect(buildEbayConsentUrl(state))
    const cookieOptions = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60,
      path: '/',
    }
    response.cookies.set('ebay_oauth_state', state, cookieOptions)
    response.cookies.set('ebay_oauth_return_to', returnTo, cookieOptions)
    if (sellerAccountId) {
      response.cookies.set('ebay_oauth_seller_account_id', sellerAccountId, cookieOptions)
    } else {
      response.cookies.delete('ebay_oauth_seller_account_id')
    }
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'eBay接続を開始できませんでした'
    const redirect = new URL('/extraction', request.url)
    redirect.searchParams.set('ebayError', message)
    return NextResponse.redirect(redirect)
  }
}
