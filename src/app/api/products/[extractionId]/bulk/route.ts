import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { PRODUCT_WRITE_WHITELIST } from '@/lib/pricing'

function pickAllowed(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).filter(([k]) => PRODUCT_WRITE_WHITELIST.has(k))
  )
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ extractionId: string }> }) {
  const { extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: { productId: string; [key: string]: unknown }[] = body.updates ?? []

  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: '更新データがありません' }, { status: 400 })
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const failed: { productId: string; error: string }[] = []
  const now = new Date().toISOString()

  await Promise.all(
    updates.map(async ({ productId, ...rawFields }) => {
      const fields = pickAllowed(rawFields)
      if (Object.keys(fields).length === 0) return

      const { error } = await admin
        .from('products')
        .update({ ...fields, updated_at: now })
        .eq('id', productId)
        .eq('extraction_id', extractionId)
        .eq('user_id', user.id)

      if (error) failed.push({ productId, error: error.message })
    })
  )

  if (failed.length > 0) {
    return NextResponse.json({ ok: false, failed }, { status: 207 })
  }

  return NextResponse.json({ ok: true })
}
