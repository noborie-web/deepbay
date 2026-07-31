import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { normalizeBulkEditConfig } from '@/lib/bulk-edit-settings'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function authenticatedUser() {
  const supabase = await createClient()
  return (await supabase.auth.getUser()).data.user
}

function cleanPayload(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
  if (!name) throw new Error('設定名を入力してください')
  return {
    name,
    memo: typeof body.memo === 'string' ? body.memo.trim().slice(0, 500) : '',
    is_default: body.is_default === true,
    config: normalizeBulkEditConfig(body.config),
    price_rate: Number.isFinite(Number(body.price_rate)) ? Number(body.price_rate) : 1,
    title_prefix: typeof body.title_prefix === 'string' ? body.title_prefix.slice(0, 80) : '',
    title_suffix: typeof body.title_suffix === 'string' ? body.title_suffix.slice(0, 80) : '',
    description_template: typeof body.description_template === 'string'
      ? body.description_template
      : '',
    condition_mapping: body.condition_mapping && typeof body.condition_mapping === 'object'
      ? body.condition_mapping
      : {},
  }
}

export async function GET() {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await admin()
    .from('bulk_edit_settings')
    .select('*')
    .eq('user_id', user.id)
    .order('is_default', { ascending: false })
    .order('created_at')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data ?? [] })
}

export async function POST(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json() as Record<string, unknown>
    const payload = cleanPayload(body)
    const db = admin()
    const isFirst = (await db
      .from('bulk_edit_settings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)).count === 0
    const makeDefault = payload.is_default || isFirst
    if (makeDefault) {
      await db.from('bulk_edit_settings').update({ is_default: false }).eq('user_id', user.id)
    }
    const { data, error } = await db
      .from('bulk_edit_settings')
      .insert({ ...payload, is_default: makeDefault, user_id: user.id })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ setting: data }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '入力内容が不正です' },
      { status: 400 },
    )
  }
}

export async function PATCH(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json() as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: '設定IDが必要です' }, { status: 400 })
    const payload = cleanPayload(body)
    const db = admin()
    if (payload.is_default) {
      await db.from('bulk_edit_settings').update({ is_default: false }).eq('user_id', user.id)
    }
    const { data, error } = await db
      .from('bulk_edit_settings')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ setting: data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '入力内容が不正です' },
      { status: 400 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as { id?: unknown }
  if (typeof body.id !== 'string') {
    return NextResponse.json({ error: '設定IDが必要です' }, { status: 400 })
  }
  const db = admin()
  const { data: target } = await db
    .from('bulk_edit_settings')
    .select('is_default')
    .eq('id', body.id)
    .eq('user_id', user.id)
    .single()
  const { error } = await db
    .from('bulk_edit_settings')
    .delete()
    .eq('id', body.id)
    .eq('user_id', user.id)
  if (error) {
    return NextResponse.json(
      { error: 'この設定は抽出履歴で使用中のため削除できません。名前を変更して残してください。' },
      { status: 409 },
    )
  }
  if (target?.is_default) {
    const { data: next } = await db
      .from('bulk_edit_settings')
      .select('id')
      .eq('user_id', user.id)
      .order('created_at')
      .limit(1)
      .maybeSingle()
    if (next) await db.from('bulk_edit_settings').update({ is_default: true }).eq('id', next.id)
  }
  return NextResponse.json({ ok: true })
}

