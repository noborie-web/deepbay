import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ExtractionPageClient from './ExtractionPageClient'

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
      .select('id, user_id, seller_id, display_name, is_default, ebay_user_id, ebay_marketplace_id, ebay_connected_at, created_at')
      .eq('user_id', user.id)
      .order('created_at'),
    supabase.from('listing_categories').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('bulk_edit_settings').select('*').eq('user_id', user.id).order('created_at'),
    supabase
      .from('extractions')
      .select('*, seller_account:seller_accounts(id, user_id, seller_id, display_name, is_default, ebay_user_id, ebay_marketplace_id, ebay_connected_at, created_at), category:listing_categories(*), bulk_edit_setting:bulk_edit_settings(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  return (
    <ExtractionPageClient
      profile={profile as { extraction_limit: number; extraction_used: number } | null}
      sellers={sellers ?? []}
      categories={categories ?? []}
      bulkSettings={bulkSettings ?? []}
      extractions={extractions ?? []}
    />
  )
}
