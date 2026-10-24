import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { coverShiftsForLeave } from '@/lib/cover'

// POST { leaveId, action: 'sick' | 'approve' | 'decline' }
export async function POST(req: Request) {
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

  if (action === 'decline') {
    await supabaseAdmin.from('leave_requests').update({ status: 'declined' }).eq('id', leaveId)
    return NextResponse.json({ ok: true })
  }
  if (action !== 'approve' && action !== 'sick') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  await supabaseAdmin.from('leave_requests').update({ status: 'approved' }).eq('id', leaveId)
  const results = await coverShiftsForLeave(leave)
  return NextResponse.json({ ok: true, results })
}