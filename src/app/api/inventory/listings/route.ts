import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

const PAGE_SIZE = 50

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requestedPage = Number(request.nextUrl.searchParams.get('page') ?? '1')
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const rawSearch = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  // Supabase's `or` filter uses commas and parentheses as syntax. Replacing
  // those characters keeps a user-entered search term inside the value.
  const search = rawSearch.replace(/[(),]/g, ' ').trim()
  const from = (page - 1) * PAGE_SIZE

  let query = admin()
    .from('inventory_active_listings')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)

  if (search) {
    const pattern = `%${search}%`
    query = query.or([
      `ebay_item_id.ilike.${pattern}`,
      `title.ilike.${pattern}`,
      `custom_label.ilike.${pattern}`,
    ].join(','))
  }

  const { data, error, count } = await query
    .order('fetched_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Page-scoped filtering of `listings` only reveals unmatched items on the
  // current page. Count the true total across all pages separately so the UI
  // can show an accurate "全体で未一致 N 件" figure instead of a per-page one.
  const { count: unmatchedTotal, error: unmatchedError } = await admin()
    .from('inventory_active_listings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('product_id', null)

  if (unmatchedError) return NextResponse.json({ error: unmatchedError.message }, { status: 500 })

  const total = count ?? 0
  return NextResponse.json({
    listings: data ?? [],
    total,
    unmatchedTotal: unmatchedTotal ?? 0,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  })
}
