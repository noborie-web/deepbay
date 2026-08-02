import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  decryptEbayRefreshToken,
  refreshEbayAccessToken,
} from '@/lib/ebay'
import { publishFixedPriceItem } from '@/lib/ebay-listing'
import { getDirectListingIssues } from '@/lib/listing-export'
import type { Product } from '@/types/database'
import {
  attachSourceLookupCodes,
  ensureSourceLookupCodes,
} from '@/lib/source-lookup'

const MAX_PRODUCTS_PER_REQUEST = 20
const CONCURRENCY = 3

interface RequestBody {
  extractionId?: unknown
  sellerAccountId?: unknown
  productIds?: unknown
  shippingProfile?: unknown
  paymentProfile?: unknown
  returnProfile?: unknown
  confirmed?: unknown
}

interface ListingSuccess {
  productId: string
  itemId: string
  warnings: string[]
}

interface ListingFailure {
  productId: string
  error: string
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: RequestBody
  try {
    body = await request.json() as RequestBody
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 })
  }

  const extractionId = requiredString(body.extractionId)
  const sellerAccountId = requiredString(body.sellerAccountId)
  const shippingProfileName = requiredString(body.shippingProfile)
  const paymentProfileName = requiredString(body.paymentProfile)
  const returnProfileName = requiredString(body.returnProfile)
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []

  if (body.confirmed !== true) {
    return NextResponse.json({ error: '実出品の確認が必要です' }, { status: 400 })
  }
  if (!extractionId || !sellerAccountId || !shippingProfileName || !paymentProfileName || !returnProfileName) {
    return NextResponse.json({ error: '出品セラーと3種類の出品ポリシーが必要です' }, { status: 400 })
  }
  if (
    productIds.length === 0
    || productIds.length > MAX_PRODUCTS_PER_REQUEST
    || new Set(productIds).size !== productIds.length
  ) {
    return NextResponse.json(
      { error: `商品IDは重複なしで1〜${MAX_PRODUCTS_PER_REQUEST}件指定してください` },
      { status: 400 },
    )
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const [{ data: extraction, error: extractionError }, { data: seller, error: sellerError }] = await Promise.all([
    admin
      .from('extractions')
      .select('id, seller_account_id, category:listing_categories(ebay_category_id)')
      .eq('id', extractionId)
      .eq('user_id', user.id)
      .maybeSingle(),
    admin
      .from('seller_accounts')
      .select('id, seller_id, ebay_connected_at')
      .eq('id', sellerAccountId)
      .eq('user_id', user.id)
      .maybeSingle(),
  ])
  if (extractionError || sellerError) {
    return NextResponse.json(
      { error: extractionError?.message || sellerError?.message },
      { status: 500 },
    )
  }
  if (!extraction || !seller) {
    return NextResponse.json({ error: '抽出または出品セラーが見つかりません' }, { status: 404 })
  }
  if (extraction.seller_account_id && extraction.seller_account_id !== seller.id) {
    return NextResponse.json(
      { error: '抽出時に選択したセラーと同じ出品セラーを選択してください' },
      { status: 422 },
    )
  }
  if (!seller.ebay_connected_at) {
    return NextResponse.json({ error: 'このセラーはeBayに接続されていません' }, { status: 409 })
  }

  const [{ data: credential, error: credentialError }, { data: products, error: productsError }] = await Promise.all([
    admin
      .from('ebay_account_credentials')
      .select('refresh_token_encrypted')
      .eq('seller_account_id', seller.id)
      .eq('user_id', user.id)
      .maybeSingle(),
    admin
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('extraction_id', extraction.id)
      .in('id', productIds),
  ])
  if (credentialError || productsError) {
    return NextResponse.json(
      { error: credentialError?.message || productsError?.message },
      { status: 500 },
    )
  }
  if (!credential?.refresh_token_encrypted) {
    return NextResponse.json({ error: 'eBay認証情報が見つかりません' }, { status: 409 })
  }

  const typedProducts = (products ?? []) as Product[]
  const foundIds = new Set(typedProducts.map((product) => product.id))
  const failed: ListingFailure[] = productIds
    .filter((productId) => !foundIds.has(productId))
    .map((productId) => ({ productId, error: '商品が見つかりません' }))
  const categoryRelation = extraction.category as unknown as { ebay_category_id: string | null } | null
  const categoryId = categoryRelation?.ebay_category_id ?? null
  const validProductsWithoutCodes = typedProducts.filter((product) => {
    if (product.listing_status !== 'draft') {
      failed.push({ productId: product.id, error: '出品中または出品済みの商品です' })
      return false
    }
    const issues = getDirectListingIssues(product, categoryId)
    if (issues.length > 0) {
      failed.push({ productId: product.id, error: `出品できません: ${issues.join('、')}` })
      return false
    }
    return true
  })
  let validProducts: Product[]
  try {
    const lookupCodes = await ensureSourceLookupCodes(admin, user.id, validProductsWithoutCodes)
    validProducts = attachSourceLookupCodes(validProductsWithoutCodes, lookupCodes)
  } catch (caught) {
    return NextResponse.json({
      error: caught instanceof Error ? caught.message : 'DBK-IDの発行に失敗しました',
    }, { status: 500 })
  }

  let accessToken: string
  try {
    accessToken = await refreshEbayAccessToken(
      decryptEbayRefreshToken(credential.refresh_token_encrypted),
    )
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'eBay認証の更新に失敗しました'
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 })
  }

  const succeeded: ListingSuccess[] = []
  const options = {
    categoryId,
    shippingProfileName,
    paymentProfileName,
    returnProfileName,
  }
  for (let offset = 0; offset < validProducts.length; offset += CONCURRENCY) {
    const chunk = validProducts.slice(offset, offset + CONCURRENCY)
    const results = await Promise.all(chunk.map(async (product) => {
      let ebayItemId: string | null = null
      try {
        const { data: reserved, error: reserveError } = await admin
          .from('products')
          .update({ listing_status: 'listing' })
          .eq('id', product.id)
          .eq('user_id', user.id)
          .eq('listing_status', 'draft')
          .select('id')
          .maybeSingle()
        if (reserveError) throw new Error(reserveError.message)
        if (!reserved) throw new Error('別の出品処理が進行中、またはすでに出品済みです')

        const result = await publishFixedPriceItem(accessToken, product, options)
        ebayItemId = result.itemId
        const listedAt = new Date().toISOString()
        const { error: updateError } = await admin
          .from('products')
          .update({
            listing_status: 'listed',
            listed_at: listedAt,
            ebay_item_id: result.itemId,
          })
          .eq('id', product.id)
          .eq('user_id', user.id)
          .eq('listing_status', 'listing')
        if (updateError) {
          throw new Error(`eBay出品済みですが保存に失敗しました（Item ID: ${result.itemId}）`)
        }
        return {
          ok: true as const,
          value: { productId: product.id, itemId: result.itemId, warnings: result.warningMessages },
        }
      } catch (caught) {
        if (!ebayItemId) {
          await admin
            .from('products')
            .update({ listing_status: 'draft' })
            .eq('id', product.id)
            .eq('user_id', user.id)
            .eq('listing_status', 'listing')
        }
        return {
          ok: false as const,
          value: {
            productId: product.id,
            error: (caught instanceof Error ? caught.message : 'eBay出品に失敗しました').slice(0, 500),
          },
        }
      }
    }))
    for (const result of results) {
      if (result.ok) succeeded.push(result.value)
      else failed.push(result.value)
    }
  }

  let activity = null
  if (succeeded.length > 0) {
    const { data, error } = await admin
      .from('extraction_activities')
      .insert({
        extraction_id: extraction.id,
        user_id: user.id,
        activity_type: 'direct_listed',
        label: 'eBayへダイレクト出品',
        item_count: succeeded.length,
        metadata: {
          sellerAccountId: seller.id,
          sellerId: seller.seller_id,
          ebayItemIds: succeeded.map((item) => item.itemId),
        },
      })
      .select('*')
      .single()
    if (error) {
      console.error('Failed to record direct listing activity:', error)
    } else {
      activity = data
    }
  }

  const status = succeeded.length === 0 ? 422 : failed.length > 0 ? 207 : 200
  return NextResponse.json({
    ok: failed.length === 0,
    succeeded,
    failed,
    requested: productIds.length,
    activity,
  }, { status })
}
