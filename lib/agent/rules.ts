// SERVER ONLY. The rostering rules every cover decision must pass.
// The AI agent can only act through tools that run these checks, so it can't break them.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { toYMD, fromYMD, fmtTime } from '@/lib/dates'

export const WEEKLY_HOUR_LIMIT = 38
export const MIN_SPLIT_HOURS = 2

export const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
export const hoursBetween = (start: string, end: string) => (toMin(end) - toMin(start)) / 60
export const isTime = (t: unknown): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)
const norm = (s: string | null) => (s ?? '').trim().toLowerCase()

// Monday to Sunday of the week containing this date
export function weekRange(ymd: string) {
  const d = fromYMD(ymd)
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return [toYMD(monday), toYMD(sunday)]
}

export type StaffCheck = {
  id: string
  full_name: string
  job_title: string | null
  weekHours: number
  eligible: boolean
  reason?: string
}

// Checks every staff member with this job title against the rules for one time window
export async function checkStaffForWindow(
  date: string, start: string, end: string,
  jobTitle: string | null, excludeIds: string[]
): Promise<StaffCheck[]> {
  const [weekStart, weekEnd] = weekRange(date)
  const [{ data: staff }, { data: unavail }, { data: leave }, { data: weekShifts }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, full_name, job_title').eq('role', 'staff'),
    supabaseAdmin.from('unavailability').select('staff_id').eq('date', date),
    supabaseAdmin.from('leave_requests').select('staff_id')
      .eq('status', 'approved').lte('start_date', date).gte('end_date', date),
    supabaseAdmin.from('shifts').select('*').gte('date', weekStart).lte('date', weekEnd),
  ])

  const unavailIds = new Set((unavail ?? []).map(r => r.staff_id))
  const leaveIds = new Set((leave ?? []).map(r => r.staff_id))
  const s0 = toMin(start)
  const s1 = toMin(end)
  const need = (s1 - s0) / 60

  return (staff ?? [])
    .filter(p => !excludeIds.includes(p.id))
    .filter(p => !jobTitle || norm(p.job_title) === norm(jobTitle))
    .map(p => {
      const mine = (weekShifts ?? []).filter(s => s.staff_id === p.id)
      const weekHours = mine.reduce((sum, s) => sum + hoursBetween(s.start_time, s.end_time), 0)
      const base = { id: p.id, full_name: p.full_name, job_title: p.job_title, weekHours }

      if (unavailIds.has(p.id)) return { ...base, eligible: false, reason: 'flagged unavailable that day' }
      if (leaveIds.has(p.id)) return { ...base, eligible: false, reason: 'on approved leave that day' }

      const clash = mine.find(s => s.date === date && toMin(s.start_time) < s1 && toMin(s.end_time) > s0)
      if (clash) return { ...base, eligible: false, reason: `already working ${fmtTime(clash.start_time)}–${fmtTime(clash.end_time)} that day` }

      if (weekHours + need > WEEKLY_HOUR_LIMIT) {
        return { ...base, eligible: false, reason: `already on ${weekHours}h this week, so this would take them over ${WEEKLY_HOUR_LIMIT}h` }
      }
      return { ...base, eligible: true }
    })
}