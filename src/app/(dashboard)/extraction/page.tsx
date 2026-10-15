import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ExtractionPageClient from './ExtractionPageClient'
import { ENRICHABLE_SITES } from '@/lib/enrich-sites'

export default async function ExtractionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 月間リセット期限(plan_reset_at)が過ぎていれば抽出回数を0に戻す
  // (extract/route.ts と同様、専用cronを追加せず表示時に遅延実行する。
  // 生成済みのDatabase型にFunctions定義がないためキャストして呼び出す)。
  await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
    'reset_extraction_used_if_due', { user_id: user.id },
  )

  const [
    { data: profile },
    { data: sellers },
    { data: categories },
    { data: bulkSettings },
    { data: extractions },
  ] = await Promise.all([
    supabase.from('profiles').select('extraction_limit, extraction_used').eq('id', user.id).single(),
    supabase
      .from('seller_accounts')
      .select('id, user_id, seller_id, display_name, is_default, ebay_user_id, ebay_marketplace_id, ebay_connected_at, listing_site_ids, created_at')
      .eq('user_id', user.id)
      .order('created_at'),
    supabase.from('listing_categories').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('bulk_edit_settings').select('*').eq('user_id', user.id).order('created_at'),
    supabase
      .from('extractions')
      .select('*, seller_account:seller_accounts(id, user_id, seller_id, display_name, is_default, ebay_user_id, ebay_marketplace_id, ebay_connected_at, listing_site_ids, created_at), category:listing_categories(*), bulk_edit_setting:bulk_edit_settings(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  // ユーザー要望(2026-10-15): 商品ページからの補完が残っているかを、抽出結果を
  // 開かなくても一覧で分かるようにする。件数はDB側で数える(一覧50件ぶんの
  // productsをそのまま取るとPostgRESTの行上限で黙って切られ、誤った件数になる)。
  const extractionIds = ((extractions ?? []) as Array<{ id: string }>).map((row) => row.id)
  let enrichPending: Record<string, { pending: number; total: number }> = {}
  if (extractionIds.length > 0) {
    const { data: pendingRows, error: pendingError } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>,
    ) => Promise<{ data: Array<{ extraction_id: string; pending: number; total: number }> | null; error: unknown }>)(
      'extraction_enrich_pending',
      { p_user_id: user.id, p_extraction_ids: extractionIds, p_sites: [...ENRICHABLE_SITES] },
    )
    // 集計に失敗したら「補完待ち0件」と見せず、表示自体を出さない
    if (pendingError) {
      console.warn('[extraction] enrich pending count failed:', pendingError)
    } else {
      enrichPending = Object.fromEntries(
        (pendingRows ?? []).map((row) => [row.extraction_id, { pending: Number(row.pending), total: Number(row.total) }]),
      )
    }
  }

  return (
    <ExtractionPageClient
      enrichPending={enrichPending}
      profile={profile as { extraction_limit: number; extraction_used: number } | null}
      sellers={sellers ?? []}
      categories={categories ?? []}
      bulkSettings={bulkSettings ?? []}
      extractions={extractions ?? []}
    />
  )
}
