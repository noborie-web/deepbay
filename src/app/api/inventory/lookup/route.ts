import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { extractSourceLookupCode } from '@/lib/inventory'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const code = req.nextUrl.searchParams.get('code')?.trim() ?? ''
  if (!code) return NextResponse.json({ error: 'codeパラメータが必要です' }, { status: 400 })

  const lookupCode = extractSourceLookupCode(code) ?? code

  const { data, error } = await admin()
    .from('products')
    .select('id, source_url, original_title, source_item_id')
    .eq('user_id', user.id)
    .eq('source_item_id', lookupCode)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ found: false, source_url: null })

  return NextResponse.json({
    found: true,
    source_url: data.source_url,
    title: data.original_title,
    product_id: data.id,
  })
}
