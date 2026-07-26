import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

const REASON_CODE_PATTERN = /^[a-z0-9_]{1,50}$/

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    productIds?: unknown
    reasonCode?: unknown
    reasonLabel?: unknown
    metadata?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '不正なJSONです' }, { status: 400 })
  }
  if (
    !Array.isArray(body.productIds)
    || body.productIds.length === 0
    || body.productIds.length > 500
    || body.productIds.some((value) => typeof value !== 'string' || value.trim() === '')
  ) {
    return NextResponse.json({ error: '除外商品IDは1〜500件で指定してください' }, { status: 400 })
  }
  const productIds = [...new Set(body.productIds as string[])]
  if (
    typeof body.reasonCode !== 'string'
    || !REASON_CODE_PATTERN.test(body.reasonCode)
    || typeof body.reasonLabel !== 'string'
    || body.reasonLabel.trim() === ''
    || body.reasonLabel.length > 100
  ) {
    return NextResponse.json({ error: '除外理由が無効です' }, { status: 400 })
  }
  const reasonCode = body.reasonCode
  const reasonLabel = body.reasonLabel.trim()
  const metadata = body.metadata !== null
    && typeof body.metadata === 'object'
    && !Array.isArray(body.metadata)
    ? body.metadata
    : {}

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: extraction } = await admin
    .from('extractions')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!extraction) {
    return NextResponse.json({ error: '抽出が存在しないか、操作権限がありません' }, { status: 404 })
  }

  const { data: products, error: productError } = await admin
    .from('products')
    .select('id, source_url, original_title, original_price, original_images')
    .eq('extraction_id', id)
    .eq('user_id', user.id)
    .in('id', productIds)
  if (productError) return NextResponse.json({ error: productError.message }, { status: 500 })
  if (!products || products.length !== productIds.length) {
    return NextResponse.json(
      { error: '一部の商品が存在しないか、除外権限がありません' },
      { status: 404 },
    )
  }

  const excludedAt = new Date().toISOString()
  const archiveRows = products.map((product) => ({
    extraction_id: id,
    user_id: user.id,
    product_id: product.id,
    reason_code: reasonCode,
    reason_label: reasonLabel,
    source_url: product.source_url,
    original_title: product.original_title,
    original_price: product.original_price,
    image_url: Array.isArray(product.original_images) ? product.original_images[0] ?? null : null,
    metadata,
    excluded_at: excludedAt,
  }))
  const { error: archiveError } = await admin
    .from('excluded_products')
    .upsert(archiveRows, {
      onConflict: 'extraction_id,product_id',
      ignoreDuplicates: true,
    })
  if (archiveError) return NextResponse.json({ error: archiveError.message }, { status: 500 })

  const { error: deleteError } = await admin
    .from('products')
    .delete()
    .eq('extraction_id', id)
    .eq('user_id', user.id)
    .in('id', productIds)
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  const { data: activity, error: activityError } = await admin
    .from('extraction_activities')
    .insert({
      extraction_id: id,
      user_id: user.id,
      activity_type: 'excluded',
      label: reasonLabel,
      item_count: products.length,
      metadata: { ...metadata, reasonCode },
      created_at: excludedAt,
    })
    .select('*')
    .single()
  if (activityError) return NextResponse.json({ error: activityError.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    removedIds: products.map((product) => product.id),
    activity,
  })
}
