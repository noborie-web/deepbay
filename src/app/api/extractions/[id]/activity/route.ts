import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { ExtractionActivityType } from '@/types/database'

const CLIENT_ACTIVITY_TYPES = new Set<ExtractionActivityType>([
  'edited',
  'csv_exported',
  'specifics_csv_exported',
])

async function authenticateExtraction(id: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

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
    return {
      error: NextResponse.json({ error: '抽出が存在しないか、閲覧権限がありません' }, { status: 404 }),
    }
  }
  return { user, admin }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authenticated = await authenticateExtraction(id)
  if ('error' in authenticated) return authenticated.error
  const { user, admin } = authenticated

  const [{ data: activities, error: activityError }, { data: excluded, error: excludedError }] =
    await Promise.all([
      admin
        .from('extraction_activities')
        .select('*')
        .eq('extraction_id', id)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      admin
        .from('excluded_products')
        .select('*')
        .eq('extraction_id', id)
        .eq('user_id', user.id)
        .order('excluded_at', { ascending: false }),
    ])

  const error = activityError ?? excludedError
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ activities: activities ?? [], excludedProducts: excluded ?? [] })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authenticated = await authenticateExtraction(id)
  if ('error' in authenticated) return authenticated.error
  const { user, admin } = authenticated

  let body: {
    activityType?: unknown
    label?: unknown
    itemCount?: unknown
    metadata?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '不正なJSONです' }, { status: 400 })
  }

  if (
    typeof body.activityType !== 'string'
    || !CLIENT_ACTIVITY_TYPES.has(body.activityType as ExtractionActivityType)
  ) {
    return NextResponse.json({ error: '記録できない操作種別です' }, { status: 400 })
  }
  if (typeof body.label !== 'string' || body.label.trim() === '' || body.label.length > 100) {
    return NextResponse.json({ error: '操作名が無効です' }, { status: 400 })
  }
  const itemCount = typeof body.itemCount === 'number' && Number.isInteger(body.itemCount)
    ? body.itemCount
    : 0
  if (itemCount < 0 || itemCount > 100_000) {
    return NextResponse.json({ error: '件数が無効です' }, { status: 400 })
  }
  const metadata = body.metadata !== null
    && typeof body.metadata === 'object'
    && !Array.isArray(body.metadata)
    ? body.metadata
    : {}

  const { data, error } = await admin
    .from('extraction_activities')
    .insert({
      extraction_id: id,
      user_id: user.id,
      activity_type: body.activityType,
      label: body.label.trim(),
      item_count: itemCount,
      metadata,
    })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ activity: data }, { status: 201 })
}
