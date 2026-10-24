import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { coverShiftsForLeave, undoCoverForLeave, alertManagers } from '@/lib/cover'
import { fmtDate } from '@/lib/dates'

// POST { leaveId, action: 'sick' | 'approve' | 'decline' }
export async function POST(req: Request) {
  try {
    // Who is calling?
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })

    const { leaveId, action } = await req.json()

    const { data: leave } = await supabaseAdmin.from('leave_requests').select('*').eq('id', leaveId).single()
    if (!leave) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (leave.status !== 'pending') return NextResponse.json({ error: 'This request has already been handled' }, { status: 400 })

    // Managers can approve or decline anything. Staff can only trigger their own sick call.
    const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    const isManager = caller?.role === 'manager'
    const isOwnSickCall = action === 'sick' && leave.type === 'sick' && leave.staff_id === user.id
    if (!isManager && !isOwnSickCall) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    }

    // Manager declines: give back any shifts that were moved, then mark declined
    if (action === 'decline') {
      await undoCoverForLeave(leave, 'declined')
      await supabaseAdmin.from('leave_requests').update({ status: 'declined' }).eq('id', leaveId)
      return NextResponse.json({ ok: true, status: 'declined' })
    }

    // Sick call: try to cover first. Only auto-approve if every shift was covered.
    if (action === 'sick') {
      const results = await coverShiftsForLeave(leave)
      const allCovered = results.every(r => r.covered)

      if (allCovered) {
        await supabaseAdmin.from('leave_requests').update({ status: 'approved' }).eq('id', leaveId)
        return NextResponse.json({ ok: true, status: 'approved', results })
      }

      const { data: absent } = await supabaseAdmin.from('profiles').select('full_name').eq('id', leave.staff_id).single()
      await alertManagers(
        `${absent?.full_name}'s sick call for ${fmtDate(leave.start_date)} is waiting for you under Leave requests, because not every shift could be covered. Arrange cover, then approve or decline it.`
      )
      return NextResponse.json({ ok: true, status: 'pending', results })
    }

    // Manager approves: mark approved, then cover anything still uncovered
    if (action === 'approve') {
      await supabaseAdmin.from('leave_requests').update({ status: 'approved' }).eq('id', leaveId)
      const results = await coverShiftsForLeave(leave)
      return NextResponse.json({ ok: true, status: 'approved', results })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('process failed:', err)
    return NextResponse.json(
      { error: `Processing crashed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}