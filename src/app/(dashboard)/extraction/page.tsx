import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ExtractionPageClient from './ExtractionPageClient'

export default async function ExtractionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: profile },
    { data: sellers },
    { data: categories },
    { data: bulkSettings },
    { data: extractions },
  ] = await Promise.all([
    supabase.from('profiles').select('extraction_limit, extraction_used').eq('id', user.id).single(),
    supabase.from('seller_accounts').select('*').eq('user_id', user.id).order('created_at'),
    supabase.from('listing_categories').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('bulk_edit_settings').select('*').eq('user_id', user.id).order('created_at'),
    supabase.from('extractions').select('*, seller_account:seller_accounts(*), category:listing_categories(*), bulk_edit_setting:bulk_edit_settings(name)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
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
