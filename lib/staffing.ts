// Works out which parts of which shifts are overstaffed, compared with the Staffing needs settings.
import { fromYMD } from '@/lib/dates'

export type Rule = { day_of_week: number; job_title: string; min_staff: number; start_time: string; end_time: string }
export type Period = { start: number; end: number } // minutes from midnight
type ShiftLike = { id: number; staff_id: string; date: string; start_time: string; end_time: string; status: string }

// Amber stripes (used for the colour key and the striped overlay)
export const STRIPES_CLASS =
  'bg-[repeating-linear-gradient(135deg,rgba(245,158,11,0.35)_0px,rgba(245,158,11,0.35)_6px,transparent_6px,transparent_12px)]'
export const OVERSTAFFED_CLASS = `${STRIPES_CLASS} ring-2 ring-inset ring-amber-400`

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

// 540 -> "9am", 810 -> "1:30pm"
export function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = min % 60
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`
}

// Joins overlapping or touching periods: 9–10 + 10–11 -> 9–11
export function mergePeriods(list: Period[]): Period[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Period[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end)
    else out.push({ ...p })
  }
  return out
}

// For each shift id, the stretches of time where that shift's role has more people than needed
export function findOverstaffedPeriods(
  shifts: ShiftLike[],
  roleOf: Map<string, string | null>,
  rules: Rule[]
): Map<number, Period[]> {
  const result = new Map<number, Period[]>()
  const rolesWithRules = new Set(rules.map(r => norm(r.job_title)))

  const add = (id: number, start: number, end: number) => {
    result.set(id, mergePeriods([...(result.get(id) ?? []), { start, end }]))
  }

  // Group the shifts that are actually staffed by date
  const byDate = new Map<string, ShiftLike[]>()
  for (const s of shifts) {
    if (s.status === 'needs_cover') continue
    byDate.set(s.date, [...(byDate.get(s.date) ?? []), s])
  }

  for (const [date, dayShifts] of byDate) {
    const dow = fromYMD(date).getDay()
    const dayRules = rules.filter(r => r.day_of_week === dow)

    const byRole = new Map<string, ShiftLike[]>()
    for (const s of dayShifts) {
      const role = norm(roleOf.get(s.staff_id))
      if (!role || !rolesWithRules.has(role)) continue
      byRole.set(role, [...(byRole.get(role) ?? []), s])
    }

    for (const [role, roleShifts] of byRole) {
      const roleRules = dayRules.filter(r => norm(r.job_title) === role)
      const points = [...new Set([
        ...roleShifts.flatMap(s => [toMin(s.start_time), toMin(s.end_time)]),
        ...roleRules.flatMap(r => [toMin(r.start_time), toMin(r.end_time)]),
      ])].sort((a, b) => a - b)

      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1]
        const working = roleShifts.filter(s => toMin(s.start_time) <= a && toMin(s.end_time) >= b)
        const needed = roleRules
          .filter(r => toMin(r.start_time) <= a && toMin(r.end_time) >= b)
          .reduce((sum, r) => sum + (r.min_staff || 0), 0)
        if (working.length > needed) working.forEach(s => add(s.id, a, b))
      }
    }
  }

  return result
}