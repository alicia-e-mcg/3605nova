// Joins back-to-back shifts for the same person on the same day into one display shift.
// The database keeps them separate (so cover can be undone and tracked); this is just for showing them.
export type BaseShift = {
  id: number; staff_id: string; date: string
  start_time: string; end_time: string; status: string
  ai_generated?: boolean
}
export type Merged<T extends BaseShift> = T & { parts: T[] }

export function mergeShifts<T extends BaseShift>(list: T[]): Merged<T>[] {
  const sorted = [...list].sort((a, b) =>
    a.staff_id.localeCompare(b.staff_id) ||
    a.date.localeCompare(b.date) ||
    a.start_time.localeCompare(b.start_time)
  )

  const out: Merged<T>[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    // Joins shifts that touch or overlap (same person, same day)
    const joinsOn =
      last &&
      last.staff_id === s.staff_id &&
      last.date === s.date &&
      last.end_time.slice(0, 5) >= s.start_time.slice(0, 5)

    if (joinsOn) {
      last.parts.push(s)
      const status =
        last.status === 'needs_cover' || s.status === 'needs_cover' ? 'needs_cover'
        : last.status === 'covered' || s.status === 'covered' ? 'covered'
        : last.status
      Object.assign(last, {
        end_time: s.end_time.slice(0, 5) > last.end_time.slice(0, 5) ? s.end_time : last.end_time,
        status,
        ai_generated: !!(last.ai_generated || s.ai_generated),
      })
    } else {
      out.push({ ...s, parts: [s] })
    }
  }

  // Back into date and time order for display
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time))
}