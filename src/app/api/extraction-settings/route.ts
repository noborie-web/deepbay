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

  const db = admin()
  const [settings, sellers, words, replaces, templates, vero] = await Promise.all([
    db.from('extraction_settings').select('*').eq('user_id', user.id).single(),
    db.from('danger_sellers').select('*').eq('user_id', user.id).order('created_at'),
    db.from('danger_words').select('*').eq('user_id', user.id).order('created_at'),
    db.from('replace_words').select('*').eq('user_id', user.id).order('created_at'),
    db.from('html_templates').select('*').eq('user_id', user.id).order('created_at'),
    db.from('vero_brands').select('*').eq('user_id', user.id).order('created_at'),
  ])

  return NextResponse.json({
    settings: settings.data,
    sellers: sellers.data ?? [],
    words: words.data ?? [],
    replaces: replaces.data ?? [],
    templates: templates.data ?? [],
    vero: vero.data ?? [],
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { type, ...payload } = body
  const db = admin()

  if (type === 'settings') {
    const { error } = await db.from('extraction_settings').upsert({
      user_id: user.id,
      ...payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (type === 'seller') {
    // bulk or single
    if (Array.isArray(payload.seller_urls)) {
      const rows = payload.seller_urls.map((url: string) => ({ user_id: user.id, seller_url: url }))
      const { error } = await db.from('danger_sellers').insert(rows)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('danger_sellers').insert({ user_id: user.id, seller_url: payload.seller_url })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (type === 'word') {
    if (Array.isArray(payload.words)) {
      const rows = payload.words.map((word: string) => ({ user_id: user.id, word }))
      const { error } = await db.from('danger_words').insert(rows)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('danger_words').insert({ user_id: user.id, word: payload.word })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (type === 'replace') {
    if (Array.isArray(payload.pairs)) {
      const rows = payload.pairs.map((p: { before: string; after: string }) => ({ user_id: user.id, before_word: p.before, after_word: p.after }))
      const { error } = await db.from('replace_words').insert(rows)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('replace_words').insert({ user_id: user.id, before_word: payload.before_word, after_word: payload.after_word })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (type === 'vero') {
    if (Array.isArray(payload.brands)) {
      const rows = payload.brands.map((b: string) => ({ user_id: user.id, brand: b }))
      const { error } = await db.from('vero_brands').insert(rows)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('vero_brands').insert({ user_id: user.id, brand: payload.brand })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (type === 'template') {
    const { error } = await db.from('html_templates').insert({ user_id: user.id, name: payload.name, content: payload.content ?? '' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (type === 'template_update') {
    const { error } = await db.from('html_templates')
      .update({ content: payload.content, updated_at: new Date().toISOString() })
      .eq('id', payload.id)
      .eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { type, id } = await req.json()
  const db = admin()

  const tableMap: Record<string, string> = {
    seller: 'danger_sellers',
    word: 'danger_words',
    replace: 'replace_words',
    vero: 'vero_brands',
    template: 'html_templates',
  }
  const table = tableMap[type]
  if (!table) return NextResponse.json({ error: 'Unknown type' }, { status: 400 })

  const { error } = await db.from(table).delete().eq('id', id).eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
