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

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data, error } = await db
    .from('auto_extraction_schedules')
    .select('*')
    .eq('user_id', user.id)
    .order('schedule_day_of_month')
    .order('schedule_time')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    const schedulesWithLatestRun = await Promise.all((data ?? []).map(async (schedule) => {
      const { data: latestRun, error: runError } = await db
        .from('auto_extraction_runs')
        .select('id, extraction_id, status, result_summary, error_message, created_at, finished_at')
        .eq('schedule_id', schedule.id)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (runError) throw new Error(runError.message)
      return { ...schedule, latest_run: latestRun ?? null }
    }))
    return NextResponse.json({ schedules: schedulesWithLatestRun })
  } catch (runError) {
    const message = runError instanceof Error ? runError.message : String(runError)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = parseAutoExtractionScheduleInput(await req.json().catch(() => null))
  if (!parsed.data) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const db = admin()
  const referenceError = await validateOwnedScheduleReferences(db, user.id, parsed.data)
  if (referenceError) {
    return NextResponse.json({ error: referenceError.error }, { status: referenceError.status })
  }

  const { data, error } = await db.from('auto_extraction_schedules')
    .insert({ user_id: user.id, ...parsed.data })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ schedule: data }, { status: 201 })
}
