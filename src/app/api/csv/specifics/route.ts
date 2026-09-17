import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS,
  generateSpecificsCsv,
  specificsInColumnCount,
  specificsInFilename,
} from '@/lib/listing-export'
import { loadActiveHtmlTemplate } from '@/lib/html-template'
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
  const formatVersion = searchParams.get('formatVersion')?.trim()
  if (formatVersion !== 'specificsin-45-v1') {
    return NextResponse.json(
      { error: '旧形式のCSV出力は廃止されました。画面を再読み込みして45列CSVを出力してください' },
      { status: 410 },
    )
  }
  if (!extractionId || (!sellerAccountId && !requestedSellerId)) {
    return NextResponse.json({ error: '抽出IDと出品セラーIDが必要です' }, { status: 400 })
  }
  if (!paymentProfile || !returnProfile || !shippingProfile) {
    return NextResponse.json({ error: '配送・支払・返品ポリシーをすべて入力してください' }, { status: 400 })
  }

  const { data: extractionData } = await supabase
    .from('extractions')
    .select('seller_account_id, category:listing_categories(ebay_category_id, condition_map)')
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

  // ユーザー要望: Item Specifics(C:列)を、全カテゴリ共通の固定リスト
  // ではなく、実際の出品先カテゴリでeBayが認識する項目に合わせたい。
  // 取得できない場合(未対応カテゴリ・API障害等)は従来の固定リストに
  // フォールバックする。
  const categoryId = extraction.category?.ebay_category_id ?? null
  const conditionMap = extraction.category?.condition_map ?? null
  // 抽出設定「HTML設定」でアクティブにしたテンプレート(あれば説明文に適用)
  const htmlTemplate = await loadActiveHtmlTemplate(supabase, user.id)
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const categoryAspectNames = categoryId
    ? await getCategoryItemSpecificsNames(categoryId, admin)
    : null
  const itemSpecificColumns = categoryAspectNames ?? EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS

  const csv = generateSpecificsCsv(products as Product[], {
    categoryId,
    conditionMap,
    htmlTemplate,
    sellerId: seller.seller_id,
    paymentProfileName: paymentProfile,
    returnProfileName: returnProfile,
    shippingProfileName: shippingProfile,
  }, itemSpecificColumns)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Specifics-In-Format': '45-columns-v1',
      'X-Specifics-In-Columns': String(specificsInColumnCount(itemSpecificColumns)),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${specificsInFilename(
        seller.seller_id,
        extraction.category?.ebay_category_id ?? null,
        extractionId,
      )}"`,
    },
  })
}
