import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { validateProfitTiers, type ProfitTier } from '@/lib/pricing'

// ユーザー要望: 段階利益の設定を「デフォルト設定1(控えめ)」「デフォルト設定2
// (積極)」のように名前を付けて複数保存し、切り替えて使えるようにする。
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

const MAX_PRESETS = 20
const MAX_NAME_LENGTH = 40

function parseTiers(value: unknown): { tiers?: ProfitTier[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: '価格帯は1件以上必要です' }
  const tiers: ProfitTier[] = (value as Array<Record<string, unknown>>).map((t, index) => {
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
  const validationError = validateProfitTiers(tiers)
  if (validationError) return { error: validationError }
  return { tiers }
}

export async function GET() {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await admin()
    .from('price_tier_presets')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ presets: data ?? [] })
}

// 同名のプリセットがあれば上書き、なければ新規作成
export async function PUT(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'リクエスト内容が不正です' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: '設定名を入力してください' }, { status: 400 })
  if (name.length > MAX_NAME_LENGTH) return NextResponse.json({ error: `設定名は${MAX_NAME_LENGTH}文字以内にしてください` }, { status: 400 })

  const { tiers, error: tiersError } = parseTiers(body.tiers)
  if (tiersError) return NextResponse.json({ error: tiersError }, { status: 400 })

  const db = admin()
  const { count } = await db
    .from('price_tier_presets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  const { data: existing } = await db
    .from('price_tier_presets')
    .select('id')
    .eq('user_id', user.id)
    .eq('name', name)
    .maybeSingle()
  if (!existing && (count ?? 0) >= MAX_PRESETS) {
    return NextResponse.json({ error: `保存できる設定は${MAX_PRESETS}件までです` }, { status: 400 })
  }

  const numberField = (value: unknown, fallback: number) =>
    typeof value === 'number' && isFinite(value) ? value : fallback

  const payload = {
    user_id: user.id,
    name,
    tiers,
    ebay_fee_rate: numberField(body.ebay_fee_rate, 0.133),
    shipping_jpy: numberField(body.shipping_jpy, 2000),
    fixed_cost_usd: numberField(body.fixed_cost_usd, 0),
    ad_rate: numberField(body.ad_rate, 0),
    customs_rate: numberField(body.customs_rate, 0),
    discount_rate: numberField(body.discount_rate, 0),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await db
    .from('price_tier_presets')
    .upsert(payload, { onConflict: 'user_id,name' })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ preset: data })
}

export async function DELETE(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id を指定してください' }, { status: 400 })

  const { error } = await admin()
    .from('price_tier_presets')
    .delete()
    .eq('user_id', user.id)
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
