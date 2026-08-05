import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await admin()
    .from('inventory_settings')
    .select('id, sync_enabled, ebay_auto_sync, days_until_delist, daily_run_count, ebay_token_expires_at, ebay_token, auto_delist, auto_revise_price, auto_stack, schedule_time, payment_profile_name, return_profile_name, shipping_profile_name, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    settings: data ? {
      id: data.id,
      has_token: !!data.ebay_token,
      sync_enabled: data.sync_enabled,
      ebay_auto_sync: data.ebay_auto_sync ?? false,
      days_until_delist: data.days_until_delist ?? 29,
      daily_run_count: data.daily_run_count ?? 1,
      ebay_token_expires_at: data.ebay_token_expires_at,
      auto_delist: data.auto_delist ?? false,
      auto_revise_price: data.auto_revise_price ?? false,
      auto_stack: data.auto_stack ?? false,
      schedule_time: data.schedule_time ?? '09:00',
      payment_profile_name: data.payment_profile_name ?? '',
      return_profile_name: data.return_profile_name ?? '',
      shipping_profile_name: data.shipping_profile_name ?? '',
      created_at: data.created_at,
      updated_at: data.updated_at,
    } : {
      has_token: false,
      sync_enabled: false,
      ebay_auto_sync: false,
      days_until_delist: 29,
      daily_run_count: 1,
      ebay_token_expires_at: null,
      auto_delist: false,
      auto_revise_price: false,
      auto_stack: false,
      schedule_time: '09:00',
      payment_profile_name: '',
      return_profile_name: '',
      shipping_profile_name: '',
    },
  })
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '不正なJSONです' }, { status: 400 })
  }

  const allowed: Record<string, unknown> = {}
  if (typeof body.sync_enabled === 'boolean') allowed.sync_enabled = body.sync_enabled
  if (typeof body.ebay_auto_sync === 'boolean') allowed.ebay_auto_sync = body.ebay_auto_sync
  if (typeof body.days_until_delist === 'number') allowed.days_until_delist = body.days_until_delist
  if (typeof body.daily_run_count === 'number') allowed.daily_run_count = body.daily_run_count
  if (typeof body.ebay_token === 'string') allowed.ebay_token = body.ebay_token
  if (typeof body.ebay_refresh_token === 'string') allowed.ebay_refresh_token = body.ebay_refresh_token
  if (typeof body.ebay_token_expires_at === 'string') allowed.ebay_token_expires_at = body.ebay_token_expires_at
  if (typeof body.auto_delist === 'boolean') allowed.auto_delist = body.auto_delist
  if (typeof body.auto_revise_price === 'boolean') allowed.auto_revise_price = body.auto_revise_price
  if (typeof body.auto_stack === 'boolean') allowed.auto_stack = body.auto_stack
  if (typeof body.schedule_time === 'string') allowed.schedule_time = body.schedule_time
  if (typeof body.payment_profile_name === 'string') allowed.payment_profile_name = body.payment_profile_name
  if (typeof body.return_profile_name === 'string') allowed.return_profile_name = body.return_profile_name
  if (typeof body.shipping_profile_name === 'string') allowed.shipping_profile_name = body.shipping_profile_name

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: '更新するフィールドがありません' }, { status: 400 })
  }

  const { error } = await admin()
    .from('inventory_settings')
    .upsert({
      user_id: user.id,
      ...allowed,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
