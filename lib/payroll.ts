/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER ONLY. Builds a week's payroll from confirmed shifts, then adds an AI check.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { toYMD, fromYMD, sydneyToday, fmtDate } from '@/lib/dates'
import { callAI } from '@/lib/agent/coverAgent'

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => Number(v) || 0
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })

export function addDaysYMD(ymd: string, n: number) {
  const d = fromYMD(ymd)
  d.setDate(d.getDate() + n)
  return toYMD(d)
}
export function mondayOfYMD(ymd: string) {
  const d = fromYMD(ymd)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return toYMD(d)
}
// The Monday of the most recent week that has fully finished (Sydney time)
export function lastCompletedWeekStart() {
  return addDaysYMD(mondayOfYMD(sydneyToday()), -7)
}
export function weekHasEnded(weekStart: string) {
  return addDaysYMD(weekStart, 6) < sydneyToday()
}

type Line = {
  staff_id: string; name: string; base_rate: number; shifts: number
  ordinary_hours: number; saturday_hours: number; sunday_hours: number
  holiday_hours: number; overtime_hours: number; gross_pay: number
}

export async function generatePayroll(weekStart: string) {
  const weekEnd = addDaysYMD(weekStart, 6)

  const { data: existing } = await supabaseAdmin
    .from('payroll_runs').select('*').eq('week_start', weekStart).maybeSingle()
  if (existing?.status === 'confirmed') {
    throw new Error('Payroll for this week is already confirmed and locked.')
  }

  const [{ data: settings }, { data: holidays }, { data: staff }, { data: shifts }, { count: unconfirmed }] = await Promise.all([
    supabaseAdmin.from('pay_settings').select('*').eq('id', 1).single(),
    supabaseAdmin.from('public_holidays').select('date, name').gte('date', weekStart).lte('date', weekEnd),
    supabaseAdmin.from('profiles').select('id, full_name, base_hourly_rate').eq('role', 'staff').order('full_name'),
    supabaseAdmin.from('shifts').select('*')
      .gte('date', weekStart).lte('date', weekEnd)
      .eq('ai_generated', false).neq('status', 'needs_cover')
      .order('date').order('start_time'),
    supabaseAdmin.from('shifts').select('id', { count: 'exact', head: true })
      .gte('date', weekStart).lte('date', weekEnd).eq('ai_generated', true),
  ])

  const m = {
    sat: num(settings?.saturday_multiplier ?? 1.25),
    sun: num(settings?.sunday_multiplier ?? 1.5),
    hol: num(settings?.public_holiday_multiplier ?? 2.5),
    ot: num(settings?.overtime_multiplier ?? 1.5),
    weekly: num(settings?.weekly_ordinary_hours ?? 38),
  }
  const holidayDates = new Set((holidays ?? []).map(h => h.date))

  // Work out each person's hours by category. Hours past the weekly limit become overtime.
  const lines: Line[] = (staff ?? []).map(p => {
    const mine = (shifts ?? []).filter(s => s.staff_id === p.id)
    const h = { ordinary: 0, saturday: 0, sunday: 0, holiday: 0, overtime: 0 }
    let running = 0

    for (const s of mine) {
      const hours = (toMin(s.end_time) - toMin(s.start_time)) / 60
      const ordinaryLeft = Math.max(0, m.weekly - running)
      const overtime = Math.max(0, hours - ordinaryLeft)
      const normal = hours - overtime
      const dow = fromYMD(s.date).getDay()
      const bucket: 'ordinary' | 'saturday' | 'sunday' | 'holiday' =
        holidayDates.has(s.date) ? 'holiday' : dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : 'ordinary'
      h[bucket] += normal
      h.overtime += overtime
      running += hours
    }

    const rate = num(p.base_hourly_rate)
    return {
      staff_id: p.id,
      name: p.full_name,
      base_rate: rate,
      shifts: mine.length,
      ordinary_hours: round2(h.ordinary),
      saturday_hours: round2(h.saturday),
      sunday_hours: round2(h.sunday),
      holiday_hours: round2(h.holiday),
      overtime_hours: round2(h.overtime),
      gross_pay: round2(rate * (h.ordinary + h.saturday * m.sat + h.sunday * m.sun + h.holiday * m.hol + h.overtime * m.ot)),
    }
  })

  // Things the manager should know
  const warnings: string[] = []
  if (unconfirmed) warnings.push(`${unconfirmed} AI-suggested shift(s) this week were never confirmed, so they are not included.`)
  ;(holidays ?? []).forEach(h => warnings.push(`${fmtDate(h.date)} is a public holiday (${h.name}). Hours worked that day use the public holiday rate.`))
  lines.filter(l => !l.base_rate && l.shifts).forEach(l => warnings.push(`${l.name} has no base pay rate set.`))

  // Create or refresh the run
  let runId: number
  if (existing) {
    runId = existing.id
    await supabaseAdmin.from('payroll_runs')
      .update({ status: 'draft', warnings, ai_summary: null, created_at: new Date().toISOString() })
      .eq('id', runId)
    await supabaseAdmin.from('payroll_items').delete().eq('run_id', runId)
  } else {
    const { data: run, error } = await supabaseAdmin.from('payroll_runs')
      .insert({ week_start: weekStart, week_end: weekEnd, warnings })
      .select('id').single()
    if (error || !run) throw new Error(`Could not create payroll run: ${error?.message}`)
    runId = run.id
  }

  // AI check (falls back to simple notes if the AI isn't available)
  const review = (await aiReview(weekStart, lines, warnings)) ?? fallbackReview(lines)

  const { error: itemError } = await supabaseAdmin.from('payroll_items').insert(lines.map(l => ({
    run_id: runId,
    staff_id: l.staff_id,
    base_rate: l.base_rate,
    ordinary_hours: l.ordinary_hours,
    saturday_hours: l.saturday_hours,
    sunday_hours: l.sunday_hours,
    holiday_hours: l.holiday_hours,
    overtime_hours: l.overtime_hours,
    gross_pay: l.gross_pay,
    ai_note: review.notes[l.staff_id] ?? null,
  })))
  if (itemError) throw new Error(`Could not save payroll lines: ${itemError.message}`)

  await supabaseAdmin.from('payroll_runs').update({ ai_summary: review.summary }).eq('id', runId)
  return { runId, weekStart, weekEnd }
}

function fallbackReview(lines: Line[]) {
  const total = lines.reduce((s, l) => s + l.gross_pay, 0)
  const notes: Record<string, string> = {}
  for (const l of lines) {
    const bits: string[] = []
    if (!l.shifts) bits.push('No shifts this week.')
    if (l.overtime_hours) bits.push(`Includes ${l.overtime_hours}h overtime.`)
    if (l.saturday_hours || l.sunday_hours) bits.push('Worked on the weekend.')
    if (l.holiday_hours) bits.push('Worked a public holiday.')
    notes[l.staff_id] = bits.join(' ') || 'Ordinary hours only.'
  }
  return { summary: `${lines.length} staff, total ${money(total)}. Check overtime and weekend hours before confirming.`, notes }
}

async function aiReview(weekStart: string, lines: Line[], warnings: string[]) {
  const token = process.env.AZURE_OPENAI_API_KEY
  if (!token || !process.env.AZURE_OPENAI_ENDPOINT) return null

  const data = await callAI({
    messages: [
      {
        role: 'system',
        content: 'You check weekly payroll for a small Australian GP clinic before the practice manager confirms it. ' +
          'Point out anything unusual: overtime, weekend or public holiday work, staff with no shifts, missing pay rates, unconfirmed shifts. ' +
          'Do not recalculate pay. Reply only with JSON in this format: ' +
          '{"summary": "2-3 sentences for the manager", "notes": {"<staff_id>": "one short sentence about this person"}}',
      },
      { role: 'user', content: JSON.stringify({ week_start: weekStart, warnings, staff: lines }) },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  }, token)
  if (!data) return null

  try {
    const json = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}')
    return { summary: String(json.summary ?? ''), notes: (json.notes ?? {}) as Record<string, string> }
  } catch {
    return null
  }
}