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
import { EBAY_SITES, normalizeSiteKeys } from '@/lib/ebay-sites'
import { fetchJpyRate } from '@/lib/exchange-rate'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
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
  // 本番で確認した不具合(2026-09-26): 出品先にUK/AUを選んでも、Specifics-IN
  // CSVだけ常にUS・USDで出力されていた。出品CSVと同じくサイトごとに出す。
  const siteKeys = normalizeSiteKeys(searchParams.get('sites'))
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

  // 関税率の扱い(US以外では適用しない)と為替レートの調整を価格設定から読む
  const pricingModel = await loadPricingModel(admin, user.id)

  // 出品先サイトの通貨レート(円/通貨)をまとめて取得し、円高に備えた調整を
  // 同じ割合で各通貨に適用する
  const rawUsdRate = await fetchJpyRate('USD').then(r => r.rate).catch(() => 0)
  const currencyRates = new Map<string, number>()
  for (const currency of new Set(siteKeys.map(key => EBAY_SITES[key].currency))) {
    try {
      const { rate } = await fetchJpyRate(currency)
      currencyRates.set(currency, adjustedJpyRate(pricingModel, currency, rate, rawUsdRate))
    } catch (error) {
      return NextResponse.json({
        error: `${currency}の為替レートを取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      }, { status: 502 })
    }
  }
  const fallbackJpyPerUsd = currencyRates.get('USD')
    ?? adjustedJpyRate(pricingModel, 'USD', rawUsdRate, rawUsdRate)

  const files = siteKeys.map(key => {
    const site = EBAY_SITES[key]
    const jpyPerCurrency = currencyRates.get(site.currency) ?? 0
    const csvForSite = generateSpecificsCsv(products as Product[], {
      categoryId,
      conditionMap,
      htmlTemplate,
      sellerId: seller.seller_id,
      paymentProfileName: paymentProfile,
      returnProfileName: returnProfile,
      shippingProfileName: shippingProfile,
      // USは従来どおり換算しない(出品価格をそのまま使う)
      site: key === 'US' ? undefined : {
        siteId: site.siteId,
        currency: site.currency,
        jpyPerCurrency,
        fallbackJpyPerUsd,
        priceAdjustment: sitePriceAdjustment(pricingModel, site.siteId),
      },
    }, itemSpecificColumns)
    return {
      site: key,
      siteId: site.siteId,
      currency: site.currency,
      jpy_per_currency: key === 'US' ? fallbackJpyPerUsd : jpyPerCurrency,
      filename: specificsInFilename(
        seller.seller_id,
        extraction.category?.ebay_category_id ?? null,
        extractionId,
        siteKeys.length > 1 ? site.siteId : undefined,
      ),
      csv: csvForSite,
    }
  })
  const csv = files[0].csv
  // ユーザー要望: 出品CSVを出力した抽出に「出力済み」を表示する
  await admin
    .from('extractions')
    .update({ csv_exported_at: new Date().toISOString() })
    .eq('id', extractionId)
    .eq('user_id', user.id)

  // 複数サイトを選んだ場合はまとめてJSONで返す(出品CSVと同じ形)
  if (siteKeys.length > 1) {
    return NextResponse.json({ files }, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Specifics-In-Format': '45-columns-v1',
        'X-Specifics-In-Columns': String(specificsInColumnCount(itemSpecificColumns)),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Specifics-In-Format': '45-columns-v1',
      'X-Specifics-In-Columns': String(specificsInColumnCount(itemSpecificColumns)),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${files[0].filename}"`,
    },
  })
}
