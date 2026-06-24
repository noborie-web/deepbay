import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// 抽出ジョブのステータスと結果を取得
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: extraction, error } = await supabase
    .from('extractions')
    .select('*, products(*)')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (error || !extraction) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(extraction)
}
