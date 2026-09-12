import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function authenticatedUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

interface RawTier {
  maxPurchaseJpy: unknown
  profitJpy: unknown
}

function parseTiers(value: unknown): { tiers?: { maxPurchaseJpy: number | null; profitJpy: number }[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '価格帯は1件以上必要です' }
  }
  const tiers = (value as RawTier[]).map((t, index) => {
    const isLast = index === value.length - 1
    const maxPurchaseJpy = isLast
      ? null
      : (typeof t.maxPurchaseJpy === 'number' && isFinite(t.maxPurchaseJpy) ? t.maxPurchaseJpy : NaN)
    const profitJpy = typeof t.profitJpy === 'number' && isFinite(t.profitJpy) ? t.profitJpy : NaN
    return { maxPurchaseJpy, profitJpy }
  })
  if (tiers.some((t) => Number.isNaN(t.profitJpy) || (t.maxPurchaseJpy !== null && Number.isNaN(t.maxPurchaseJpy)))) {
    return { error: '価格帯の数値が不正です' }
  }
  return { tiers }
}

export async function GET() {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await admin()
    .from('price_tier_settings')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ setting: data ?? null })
}

export async function PUT(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'リクエスト内容が不正です' }, { status: 400 })

  const { tiers, error: tiersError } = parseTiers(body.tiers)
  if (tiersError) return NextResponse.json({ error: tiersError }, { status: 400 })

  const numberField = (value: unknown, fallback: number) =>
    typeof value === 'number' && isFinite(value) ? value : fallback

  const payload = {
    user_id: user.id,
    tiers,
    ebay_fee_rate: numberField(body.ebay_fee_rate, 0.133),
    shipping_jpy: numberField(body.shipping_jpy, 2000),
    fixed_cost_usd: numberField(body.fixed_cost_usd, 0),
    ad_rate: numberField(body.ad_rate, 0),
    customs_rate: numberField(body.customs_rate, 0),
    discount_rate: numberField(body.discount_rate, 0),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await admin()
    .from('price_tier_settings')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ setting: data })
}
