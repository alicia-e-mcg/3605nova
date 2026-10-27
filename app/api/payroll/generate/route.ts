import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { generatePayroll, lastCompletedWeekStart, weekHasEnded } from '@/lib/payroll'
import { alertManagers } from '@/lib/cover'
import { fmtDate } from '@/lib/dates'

export const maxDuration = 60

// Called automatically every Monday morning (Vercel Cron) to generate last week's payroll
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }
  try {
    const weekStart = lastCompletedWeekStart()
    const { data: existing } = await supabaseAdmin.from('payroll_runs').select('id').eq('week_start', weekStart).maybeSingle()
    if (existing) return NextResponse.json({ ok: true, skipped: 'Already generated' })

    await generatePayroll(weekStart)
    await alertManagers(`Payroll for the week of ${fmtDate(weekStart)} has been generated and is ready for you to review.`)
    return NextResponse.json({ ok: true, weekStart })
  } catch (err) {
    console.error('scheduled payroll failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// POST { weekStart } — the manager generates (or refreshes) payroll for a finished week
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })

    const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (caller?.role !== 'manager') return NextResponse.json({ error: 'Only the practice manager can run payroll' }, { status: 403 })

    const { weekStart } = await req.json()
    if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: 'weekStart must be YYYY-MM-DD' }, { status: 400 })
    }
    if (!weekHasEnded(weekStart)) {
      return NextResponse.json({ error: "This week hasn't finished yet. Payroll can only be generated once the week ends." }, { status: 400 })
    }

    const result = await generatePayroll(weekStart)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('payroll failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}