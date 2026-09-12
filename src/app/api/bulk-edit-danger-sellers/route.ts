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

// 一括編集設定プロファイルが自分の所有物であることを確認する
// (他ユーザーの設定IDを指定して読み書きされるのを防ぐ)。
async function assertOwnsSetting(userId: string, bulkEditSettingId: string): Promise<boolean> {
  const { data } = await admin()
    .from('bulk_edit_settings')
    .select('id')
    .eq('id', bulkEditSettingId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data
}

export async function GET(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const bulkEditSettingId = req.nextUrl.searchParams.get('bulk_edit_setting_id')
  if (!bulkEditSettingId) return NextResponse.json({ error: 'bulk_edit_setting_idが必要です' }, { status: 400 })
  if (!(await assertOwnsSetting(user.id, bulkEditSettingId))) {
    return NextResponse.json({ error: 'Setting not found' }, { status: 404 })
  }

  const { data, error } = await admin()
    .from('bulk_edit_danger_sellers')
    .select('*')
    .eq('bulk_edit_setting_id', bulkEditSettingId)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sellers: data ?? [] })
}

export async function POST(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const bulkEditSettingId = typeof body?.bulk_edit_setting_id === 'string' ? body.bulk_edit_setting_id : null
  if (!bulkEditSettingId) return NextResponse.json({ error: 'bulk_edit_setting_idが必要です' }, { status: 400 })
  if (!(await assertOwnsSetting(user.id, bulkEditSettingId))) {
    return NextResponse.json({ error: 'Setting not found' }, { status: 404 })
  }

  // ユーザー要望: 抽出危険設定(グローバル)に登録済みのセラーURLを、
  // 一括編集設定専用リストへまとめて反映できるようにしたい
  // (1件ずつ手入力するのが手間だったため)。
  if (Array.isArray(body?.seller_urls)) {
    const client = admin()
    const urls = body.seller_urls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map((u) => u.trim())
    if (urls.length === 0) return NextResponse.json({ error: 'セラーURLが必要です' }, { status: 400 })

    const { data: existing } = await client
      .from('bulk_edit_danger_sellers')
      .select('seller_url')
      .eq('bulk_edit_setting_id', bulkEditSettingId)
    const existingUrls = new Set((existing ?? []).map((e: { seller_url: string }) => e.seller_url))
    const newUrls = [...new Set(urls)].filter((u) => !existingUrls.has(u))
    if (newUrls.length === 0) return NextResponse.json({ sellers: [] }, { status: 201 })

    const { data, error } = await client
      .from('bulk_edit_danger_sellers')
      .insert(newUrls.map((seller_url) => ({ bulk_edit_setting_id: bulkEditSettingId, user_id: user.id, seller_url })))
      .select('*')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ sellers: data ?? [] }, { status: 201 })
  }

  const sellerUrl = typeof body?.seller_url === 'string' ? body.seller_url.trim() : ''
  if (!sellerUrl) return NextResponse.json({ error: 'セラーURLは必須です' }, { status: 400 })

  const { data, error } = await admin()
    .from('bulk_edit_danger_sellers')
    .insert({ bulk_edit_setting_id: bulkEditSettingId, user_id: user.id, seller_url: sellerUrl })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ seller: data }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const user = await authenticatedUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'idが必要です' }, { status: 400 })

  const { error, count } = await admin()
    .from('bulk_edit_danger_sellers')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
