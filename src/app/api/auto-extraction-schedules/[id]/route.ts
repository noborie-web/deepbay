import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  parseAutoExtractionScheduleInput,
  validateOwnedScheduleReferences,
} from '@/lib/auto-extraction-schedules'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = parseAutoExtractionScheduleInput(await req.json().catch(() => null), true)
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const db = admin()
  const referenceError = await validateOwnedScheduleReferences(db, user.id, parsed.data)
  if (referenceError) {
    return NextResponse.json({ error: referenceError.error }, { status: referenceError.status })
  }

  const { id } = await params
  const { data, error } = await db.from('auto_extraction_schedules')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
  return NextResponse.json({ schedule: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { data, error } = await admin().from('auto_extraction_schedules')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
