import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { undoCoverForLeave } from '@/lib/cover'
import { sydneyToday } from '@/lib/dates'

// POST { leaveId } — the staff member (or a manager) withdraws a leave or sick request
export async function POST(req: Request) {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: 'SUPABASE_SERVICE_ROLE_KEY is missing. Add it to .env.local and restart npm run dev.' },
        { status: 500 }
      )
    }

    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: `Not logged in: ${authError?.message ?? 'no user'}` }, { status: 401 })
    }

    const { leaveId } = await req.json()
    const { data: leave, error: leaveError } = await supabaseAdmin
      .from('leave_requests').select('*').eq('id', leaveId).single()
    if (leaveError || !leave) {
      return NextResponse.json({ error: `Request not found: ${leaveError?.message ?? ''}` }, { status: 404 })
    }

    const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    const isManager = caller?.role === 'manager'
    if (!isManager && leave.staff_id !== user.id) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    }

    if (leave.status === 'approved' && leave.end_date < sydneyToday()) {
      return NextResponse.json({ error: "This leave has already been taken, so it can't be withdrawn." }, { status: 400 })
    }

    // Give shifts back before deleting the request
    if (leave.status !== 'declined') await undoCoverForLeave(leave, 'withdrawn')
    const { error: deleteError } = await supabaseAdmin.from('leave_requests').delete().eq('id', leaveId)
    if (deleteError) {
      return NextResponse.json({ error: `Couldn't delete the request: ${deleteError.message}` }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('withdraw failed:', err)
    return NextResponse.json(
      { error: `Withdraw crashed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}