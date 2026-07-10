import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEbayCsv } from '@/lib/csv/ebay'
import type { EbayCsvOptions } from '@/lib/csv/ebay'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const extractionId = searchParams.get('extractionId')
  const productIds = searchParams.get('productIds')?.split(',').filter(Boolean) ?? []
  const category = searchParams.get('category') ?? '57988'
  const paymentProfile = searchParams.get('paymentProfile') ?? 'eBay Payments'
  const returnProfile = searchParams.get('returnProfile') ?? 'Returns Accepted,Buyer,60 Days,Money Back'
  const shippingProfile = searchParams.get('shippingProfile') ?? '3area excluded ver.'

  let query = supabase.from('products').select('*').eq('user_id', user.id)

  if (extractionId) {
    query = query.eq('extraction_id', extractionId)
  } else if (productIds.length) {
    query = query.in('id', productIds)
  } else {
    return NextResponse.json({ error: '商品IDまたは抽出IDが必要です' }, { status: 400 })
  }

  const { data: products } = await query

  if (!products?.length) {
    return NextResponse.json({ error: '商品が見つかりません' }, { status: 404 })
  }

  // productsをScrapedProduct形式に変換
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrapedProducts = products.map((p: any) => ({
    sourceUrl: p.source_url,
    sourceSite: p.source_site,
    sourceItemId: p.source_item_id,
    title: p.ebay_title ?? p.original_title,
    price: p.ebay_price ?? p.original_price,
    description: p.ebay_description ?? p.original_description ?? '',
    images: p.ebay_images ?? p.original_images ?? [],
    condition: p.original_condition,
    category: null,
    sellerRatingCount: null,
    shippingDays: null,
    sourceUpdatedAt: null,
  }))

  const options: EbayCsvOptions = {
    category,
    paymentProfileName: paymentProfile,
    returnProfileName: returnProfile,
    shippingProfileName: shippingProfile,
  }

  const csv = generateEbayCsv(scrapedProducts, options)
  const filename = `ebay_listing_${Date.now()}.csv`

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
