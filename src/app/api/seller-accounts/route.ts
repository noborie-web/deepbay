import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { EBAY_SITE_KEYS, isEbaySiteKey } from '@/lib/ebay-sites'

// ユーザー要望(2026-09-25): 出品アカウント(出品セラー)を追加・編集できるようにする。
// 複数のeBayアカウントを登録して、抽出・CSV出品・ダイレクト出品で使い分ける。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

const SELLER_ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/

// このアカウントで出品するサイト。未指定・不正な値はUSだけにする。
function normalizeListingSites(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const sites = value
    .map(v => String(v).trim().toUpperCase())
    .filter(isEbaySiteKey)
  const unique = EBAY_SITE_KEYS.filter(key => sites.includes(key))
  return unique.length > 0 ? unique : ['US']
}

async function requireUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await admin()
    .from('seller_accounts')
    .select('id, seller_id, display_name, is_default, ebay_user_id, ebay_marketplace_id, ebay_connected_at, listing_site_ids, created_at')
    .eq('user_id', user.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sellers: data ?? [] })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { seller_id?: string; display_name?: string | null; listing_site_ids?: unknown }
  const sellerId = (body.seller_id ?? '').trim()
  if (!SELLER_ID_PATTERN.test(sellerId)) {
    return NextResponse.json({ error: 'eBayセラーIDは英数字・ハイフン・アンダースコア・ドットの3〜64文字で入力してください' }, { status: 400 })
  }
  const db = admin()
  const { data: existing } = await db
    .from('seller_accounts')
    .select('id')
    .eq('user_id', user.id)
    .eq('seller_id', sellerId)
    .maybeSingle()
  if (existing) return NextResponse.json({ error: `「${sellerId}」はすでに登録されています` }, { status: 409 })

  const { count } = await db
    .from('seller_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)

  const { data, error } = await db
    .from('seller_accounts')
    .insert({
      user_id: user.id,
      seller_id: sellerId,
      display_name: body.display_name?.trim() || null,
      listing_site_ids: normalizeListingSites(body.listing_site_ids) ?? ['US'],
      // 最初の1件は既定にする
      is_default: (count ?? 0) === 0,
    })
    .select('id, seller_id, display_name, is_default')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, seller: data })
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { id?: string; display_name?: string | null; is_default?: boolean; listing_site_ids?: unknown }
  if (!body.id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  const db = admin()

  const { data: target } = await db
    .from('seller_accounts')
    .select('id')
    .eq('id', body.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!target) return NextResponse.json({ error: '出品アカウントが見つかりません' }, { status: 404 })

  const update: Record<string, unknown> = {}
  if (body.display_name !== undefined) update.display_name = body.display_name?.trim() || null
  if (body.listing_site_ids !== undefined) {
    const sites = normalizeListingSites(body.listing_site_ids)
    if (!sites) return NextResponse.json({ error: '出品サイトの指定が不正です' }, { status: 400 })
    update.listing_site_ids = sites
  }
  if (body.is_default === true) {
    // 既定は1件だけ
    const { error: clearError } = await db.from('seller_accounts').update({ is_default: false }).eq('user_id', user.id)
    if (clearError) return NextResponse.json({ error: clearError.message }, { status: 500 })
    update.is_default = true
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true })

  const { error } = await db.from('seller_accounts').update(update).eq('id', body.id).eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { id?: string }
  if (!body.id) return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  const db = admin()

  // 使用中(抽出に紐付いている)なら削除しない
  const { count } = await db
    .from('extractions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('seller_account_id', body.id)
  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: `この出品アカウントを使っている抽出が${count}件あるため削除できません` }, { status: 409 })
  }

  const { data: target } = await db
    .from('seller_accounts')
    .select('id, is_default')
    .eq('id', body.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!target) return NextResponse.json({ error: '出品アカウントが見つかりません' }, { status: 404 })

  const { error } = await db.from('seller_accounts').delete().eq('id', body.id).eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 既定を消した場合は残りの先頭を既定にする
  if (target.is_default) {
    const { data: next } = await db
      .from('seller_accounts')
      .select('id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (next) await db.from('seller_accounts').update({ is_default: true }).eq('id', next.id)
  }
  return NextResponse.json({ ok: true })
}
