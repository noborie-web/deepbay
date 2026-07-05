import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 本人の抽出であることを確認
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction } = await (supabase as any)
    .from('extractions')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!extraction) return NextResponse.json({ error: '抽出が見つかりません' }, { status: 404 })

  // service roleでRLSをバイパスして削除
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  await admin.from('products').delete().eq('extraction_id', id)
  const { error } = await admin.from('extractions').delete().eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
