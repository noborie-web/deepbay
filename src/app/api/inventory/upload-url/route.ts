import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const path = `${user.id}/${crypto.randomUUID()}.csv`
  const { data, error } = await admin.storage.from('inventory-uploads').createSignedUploadUrl(path)
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'アップロードURLを作成できません' }, { status: 500 })
  return NextResponse.json({ path, token: data.token })
}
