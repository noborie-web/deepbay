import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateSpecificsCsv, listingFilename } from '@/lib/listing-export'
import type { Product } from '@/types/database'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const extractionId = searchParams.get('extractionId')?.trim()
  const sellerAccountId = searchParams.get('sellerAccountId')?.trim()
  if (!extractionId || !sellerAccountId) {
    return NextResponse.json({ error: '抽出IDと出品セラーが必要です' }, { status: 400 })
  }

  const [{ data: extractionData }, { data: sellerData }] = await Promise.all([
    supabase
      .from('extractions')
      .select('seller_account_id, category:listing_categories(ebay_category_id)')
      .eq('id', extractionId)
      .eq('user_id', user.id)
      .single(),
    supabase
      .from('seller_accounts')
      .select('id, seller_id')
      .eq('id', sellerAccountId)
      .eq('user_id', user.id)
      .single(),
  ])
  const extraction = extractionData as unknown as {
    seller_account_id: string | null
    category: { ebay_category_id: string | null } | null
  } | null
  const seller = sellerData as unknown as { id: string; seller_id: string } | null

  if (!extraction || !seller) {
    return NextResponse.json({ error: '抽出または出品セラーが見つかりません' }, { status: 404 })
  }
  if (extraction.seller_account_id !== seller.id) {
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

  const csv = generateSpecificsCsv(products as Product[], extraction.category?.ebay_category_id ?? null)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${listingFilename(seller.seller_id, 'specifics')}"`,
    },
  })
}
