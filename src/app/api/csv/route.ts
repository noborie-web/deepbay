import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS,
  ebayUploadColumnCount,
  generateListingCsv,
  getListingIssues,
  listingFilename,
} from '@/lib/listing-export'
import { getCategoryItemSpecificsNames } from '@/lib/ebay-taxonomy'
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
    .select('id, seller_account_id, category:listing_categories(ebay_category_id, condition_map)')
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
    category: { ebay_category_id: string | null; condition_map: Record<string, string> | null } | null
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
  // 出品カテゴリー管理で設定した商品状態→ConditionIDの対応(未設定ならnull)。
  const conditionMap = extraction.category?.condition_map ?? null
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

  // ユーザー要望: Item Specifics(C:列)を、全カテゴリ共通の固定リスト
  // ではなく、実際の出品先カテゴリでeBayが認識する項目に合わせたい。
  // 取得できない場合(未対応カテゴリ・API障害等)は従来の固定リストに
  // フォールバックする。
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const categoryAspectNames = categoryId
    ? await getCategoryItemSpecificsNames(categoryId, admin)
    : null
  const itemSpecificColumns = categoryAspectNames ?? EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS

  const csv = generateListingCsv(typedProducts, {
    categoryId,
    conditionMap,
    sellerId: seller.seller_id,
    paymentProfileName: paymentProfile,
    returnProfileName: returnProfile,
    shippingProfileName: shippingProfile,
  }, itemSpecificColumns)

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${listingFilename(seller.seller_id, 'listing')}"`,
      'Cache-Control': 'no-store, max-age=0',
      'X-Ebay-Upload-Format': '42-columns-v1',
      'X-Ebay-Upload-Columns': String(ebayUploadColumnCount(itemSpecificColumns)),
    },
  })
}
