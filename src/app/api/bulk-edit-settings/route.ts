import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { DEFAULT_AUTO_PRICING } from '@/lib/pricing'

const PRICING_FIELDS = [
  'profit_rate',
  'ebay_fee_rate',
  'shipping_cost_jpy',
  'fixed_cost_usd',
] as const

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function parsePayload(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'リクエスト内容が不正です' }
  }
  const source = body as Record<string, unknown>
  if (typeof source.name !== 'string' || !source.name.trim()) {
    return { error: '設定名は必須です' }
  }

  const data: Record<string, string | number | null> = {
    name: source.name.trim(),
    title_prefix: typeof source.title_prefix === 'string' ? source.title_prefix : '',
    title_suffix: typeof source.title_suffix === 'string' ? source.title_suffix : '',
  }
  for (const field of PRICING_FIELDS) {
    const value = source[field]
    if (value === null || value === '' || value === undefined) {
      data[field] = null
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { error: `${field}は0以上の数値、または空欄にしてください` }
    }
    if (field === 'shipping_cost_jpy' && !Number.isInteger(value)) {
      return { error: 'shipping_cost_jpyは整数で指定してください' }
    }
    data[field] = value
  }

  const profitRate = (data.profit_rate as number | null) ?? DEFAULT_AUTO_PRICING.profitRate
  const ebayFeeRate = (data.ebay_fee_rate as number | null) ?? DEFAULT_AUTO_PRICING.ebayFeeRate
  if (profitRate + ebayFeeRate >= 1) {
    return { error: '目標利益率とeBay手数料率の合計は1未満にしてください' }
  }
  return { data }
}

async function authenticatedUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function POST(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = parsePayload(await req.json().catch(() => null))
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await admin().from('bulk_edit_settings')
    .insert({ user_id: user.id, ...parsed.data })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ setting: data }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const id = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).id
    : null
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: '設定IDが必要です' }, { status: 400 })
  }
  const parsed = parsePayload(body)
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await admin().from('bulk_edit_settings')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Setting not found' }, { status: 404 })
  return NextResponse.json({ setting: data })
}
