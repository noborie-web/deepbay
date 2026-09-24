import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { runQuickSupplierCheck } from '@/lib/inventory-quick-check'

// ユーザー要望(出品1,000件超への備え): メルカリ等(Yahoo!フリマ以外)の仕入先も
// 15分ごとに確認して、売り切れを早く検知する。日次の在庫管理(1回約65件)だけでは
// 1,000件の一巡に2週間以上かかるため。
// Yahoo!フリマは専用の flea-check(12件/15分)が担当するので対象外。
// 仕入先URLが無い商品(source_site='ebay')も対象外。
export const maxDuration = 60

const BATCH = 40
const TIME_BUDGET_MS = 40_000
const EXCLUDED_SITES = ['yahoo_flea', 'ebay']

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const results = await runQuickSupplierCheck(db, {
    batchSize: BATCH,
    timeBudgetMs: TIME_BUDGET_MS,
    runType: 'supplier_quick_check',
    excludeSourceSites: EXCLUDED_SITES,
    lastAtColumn: 'supplier_quick_check_last_at',
  })
  return NextResponse.json({ ok: true, results })
}
