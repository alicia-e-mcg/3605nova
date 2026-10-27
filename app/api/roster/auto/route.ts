import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { autoRosterWeek } from '@/lib/agent/autoRoster'

export const maxDuration = 120 // the agent can take a little while

// POST { weekStart: 'YYYY-MM-DD' (a Monday) } — manager only
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })

    const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (caller?.role !== 'manager') return NextResponse.json({ error: 'Only the practice manager can auto-roster' }, { status: 403 })

    const { weekStart } = await req.json()
    if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: 'weekStart must be YYYY-MM-DD' }, { status: 400 })
    }

    const result = await autoRosterWeek(weekStart, crypto.randomUUID())
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('auto-roster failed:', err)
    return NextResponse.json(
      { error: `Auto-roster crashed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}