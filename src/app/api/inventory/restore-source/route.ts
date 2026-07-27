import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  normalizeSourceLookupCode,
  SOURCE_LOOKUP_CODE_PATTERN,
} from '@/lib/source-lookup'
import type { SourceUrlLookupCode } from '@/types/database'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { dbkId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '不正な入力です' }, { status: 400 })
  }
  if (typeof body.dbkId !== 'string') {
    return NextResponse.json({ error: 'DBK-IDを入力してください' }, { status: 400 })
  }

  const lookupCode = normalizeSourceLookupCode(body.dbkId)
  if (!SOURCE_LOOKUP_CODE_PATTERN.test(lookupCode)) {
    return NextResponse.json(
      { error: 'DBK-IDの形式が正しくありません（例: ele_20260727_英数字16文字）' },
      { status: 400 },
    )
  }

  const { data, error } = await supabase
    .from('source_url_lookup_codes')
    .select('lookup_code, source_url, source_site, source_title, product_id, created_at')
    .eq('user_id', user.id)
    .eq('lookup_code', lookupCode)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const lookup = data as Pick<
    SourceUrlLookupCode,
    'lookup_code' | 'source_url' | 'source_site' | 'source_title' | 'product_id' | 'created_at'
  > | null

  if (!lookup) {
    return NextResponse.json(
      { error: 'このDBK-IDに対応する仕入れ先URLが見つかりません' },
      { status: 404 },
    )
  }

  return NextResponse.json({
    result: {
      dbkId: lookup.lookup_code,
      sourceUrl: lookup.source_url,
      sourceSite: lookup.source_site,
      title: lookup.source_title,
      productId: lookup.product_id,
      createdAt: lookup.created_at,
    },
  })
}
