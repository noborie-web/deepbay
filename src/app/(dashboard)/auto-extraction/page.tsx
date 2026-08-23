import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import AutoExtractionPageClient from './AutoExtractionPageClient'

export default async function AutoExtractionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: sellers }, { data: categories }, { data: bulkSettings }] = await Promise.all([
    supabase.from('seller_accounts')
      .select('id, seller_id, display_name, is_default')
      .eq('user_id', user.id)
      .order('created_at'),
    supabase.from('listing_categories')
      .select('id, name, ebay_category_id')
      .eq('user_id', user.id)
      .order('sort_order'),
    supabase.from('bulk_edit_settings')
      .select('id, name')
      .eq('user_id', user.id)
      .order('created_at'),
  ])

  return (
    <AutoExtractionPageClient
      sellers={sellers ?? []}
      categories={categories ?? []}
      bulkSettings={bulkSettings ?? []}
    />
  )
}
