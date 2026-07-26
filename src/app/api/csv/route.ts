import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  EBAY_UPLOAD_COLUMN_COUNT,
  generateListingCsv,
  getListingIssues,
  listingFilename,
} from '@/lib/listing-export'
import type { Product } from '@/types/database'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const extractionId = searchParams.get('extractionId')?.trim()
  const sellerAccountId = searchParams.get('sellerAccountId')?.trim()
  const requestedSellerId = searchParams.get('sellerId')?.trim()
  const paymentProfile = searchParams.get('paymentProfile')?.trim() ?? ''
  const returnProfile = searchParams.get('returnProfile')?.trim() ?? ''
  const shippingProfile = searchParams.get('shippingProfile')?.trim() ?? ''
  const formatVersion = searchParams.get('formatVersion')

  if (!extractionId || (!sellerAccountId && !requestedSellerId)) {
    return NextResponse.json({ error: '抽出IDと出品セラーIDが必要です' }, { status: 400 })
  }
  if (!paymentProfile || !returnProfile || !shippingProfile) {
    return NextResponse.json({ error: '配送・支払・返品ポリシーをすべて入力してください' }, { status: 400 })
  }
  if (formatVersion !== 'ebay-upload-42-v1') {
    return NextResponse.json({ error: 'eBay出品CSVの形式指定が不正です' }, { status: 400 })
  }

  const { data: extractionData } = await supabase
    .from('extractions')
    .select('id, seller_account_id, category:listing_categories(ebay_category_id)')
    .eq('id', extractionId)
    .eq('user_id', user.id)
    .single()
  const { data: sellerData } = sellerAccountId
    ? await supabase
      .from('seller_accounts')
      .select('id, seller_id')
      .eq('id', sellerAccountId)
      .eq('user_id', user.id)
      .single()
    : { data: null }
  const extraction = extractionData as unknown as {
    id: string
    seller_account_id: string | null
    category: { ebay_category_id: string | null } | null
  } | null
  const registeredSeller = sellerData as unknown as { id: string; seller_id: string } | null
  const seller = registeredSeller ?? (
    requestedSellerId ? { id: '', seller_id: requestedSellerId } : null
  )

  if (!extraction || !seller) {
    return NextResponse.json({ error: '抽出または出品セラーが見つかりません' }, { status: 404 })
  }
  if (extraction.seller_account_id && extraction.seller_account_id !== seller.id) {
    return NextResponse.json(
      { error: '抽出時に選択したセラーと同じ出品セラーを選択してください' },
      { status: 422 },
    )
  }

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .order('created_at', { ascending: true })

  if (!products?.length) {
    return NextResponse.json({ error: '商品が見つかりません' }, { status: 404 })
  }

  const categoryId = extraction.category?.ebay_category_id ?? null
  const typedProducts = products as Product[]
  const invalid = typedProducts
    .map((product) => ({ productId: product.id, issues: getListingIssues(product, categoryId) }))
    .filter((item) => item.issues.length > 0)
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `出品必須項目が未設定の商品が${invalid.length}件あります`, invalid },
      { status: 422 },
    )
  }

  const csv = generateListingCsv(typedProducts, {
    categoryId,
    sellerId: seller.seller_id,
    paymentProfileName: paymentProfile,
    returnProfileName: returnProfile,
    shippingProfileName: shippingProfile,
  })

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${listingFilename(seller.seller_id, 'listing')}"`,
      'Cache-Control': 'no-store, max-age=0',
      'X-Ebay-Upload-Format': '42-columns-v1',
      'X-Ebay-Upload-Columns': String(EBAY_UPLOAD_COLUMN_COUNT),
    },
  })
}
