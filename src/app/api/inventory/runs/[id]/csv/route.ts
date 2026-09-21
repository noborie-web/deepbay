import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { buildRunCsv } from '@/lib/inventory-run-csv'

// ユーザー要望: 公式ツールのように、価格追従・差分検知・取り下げの「結果」を
// 実行ごとにCSV(revise / diff / end_items 形式)で出力する。
// inventory_runs.result_summary.items(実行時に記録した1商品ごとの結果)から生成する。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const kind = req.nextUrl.searchParams.get('kind') ?? 'auto'
  const { data: run, error } = await admin()
    .from('inventory_runs')
    .select('id, run_type, started_at, result_summary')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!run) return NextResponse.json({ error: '実行履歴が見つかりません' }, { status: 404 })

  const seller = user.email?.split('@')[0] ?? 'user'
  const built = buildRunCsv(run, kind, seller)
  if (!built) return NextResponse.json({ error: 'この実行にはCSVに出力できる結果がありません' }, { status: 400 })
  return NextResponse.json({ csv: '﻿' + built.csv, filename: built.filename, rows: built.rows })
}
