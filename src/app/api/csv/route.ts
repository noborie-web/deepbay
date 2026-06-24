import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEbayCsv } from '@/lib/csv/ebay'

// ?productIds=id1,id2&bulkSettingId=xxx でCSVダウンロード
export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const productIds = searchParams.get('productIds')?.split(',').filter(Boolean) ?? []
  const bulkSettingId = searchParams.get('bulkSettingId')

  if (!productIds.length) {
    return NextResponse.json({ error: '商品IDが必要です' }, { status: 400 })
  }

  const [{ data: products }, { data: bulkSetting }] = await Promise.all([
    supabase
      .from('products')
      .select('*')
      .in('id', productIds)
      .eq('user_id', user.id),
    bulkSettingId
      ? supabase.from('bulk_edit_settings').select('*').eq('id', bulkSettingId).single()
      : Promise.resolve({ data: null }),
  ])

  if (!products?.length) {
    return NextResponse.json({ error: '商品が見つかりません' }, { status: 404 })
  }

  const csv = generateEbayCsv(products, bulkSetting)

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ebay_listing_${Date.now()}.csv"`,
    },
  })
}
