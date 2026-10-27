/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER ONLY. Drafts a week's roster from the coverage rules, then lets the AI agent try to fill any gaps.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { toYMD, fromYMD } from '@/lib/dates'
import { checkStaffForWindow, toMin } from '@/lib/agent/rules'
import { runGapAgent, type Gap, type AddedShift } from '@/lib/agent/gapAgent'

type Rule = { id: number; day_of_week: number; job_title: string; min_staff: number; start_time: string; end_time: string }

const hhmm = (t: string) => t.slice(0, 5)
const norm = (s: string | null) => (s ?? '').trim().toLowerCase()

export async function autoRosterWeek(weekStart: string, runId: string) {
  const start = fromYMD(weekStart)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
  const weekEnd = toYMD(days[6])

  // 1. Replace any earlier unconfirmed auto-roster draft for this week
  await supabaseAdmin
    .from('shifts').delete()
    .gte('date', weekStart).lte('date', weekEnd)
    .eq('ai_generated', true)
    .not('roster_run_id', 'is', null)

  // 2. Coverage rules, staff, and the shifts already in this week
  const [{ data: rules }, { data: staff }, { data: existing }] = await Promise.all([
    supabaseAdmin.from('coverage_rules').select('*'),
    supabaseAdmin.from('profiles').select('id, full_name, job_title').eq('role', 'staff'),
    supabaseAdmin.from('shifts').select('*').gte('date', weekStart).lte('date', weekEnd),
  ])

  const weekShifts: any[] = [...(existing ?? [])]
  const usedShiftIds = new Set<number>()
  const bookedThatDay = new Set(weekShifts.map(s => `${s.staff_id}|${s.date}`))
  const added: AddedShift[] = []
  const gaps: Gap[] = []

  // 3. Fill each day's requirements, fairest first
  for (const d of days) {
    const date = toYMD(d)
    const todaysRules = ((rules ?? []) as Rule[])
      .filter(r => r.day_of_week === d.getDay())
      .sort((a, b) => a.start_time.localeCompare(b.start_time))

    for (const rule of todaysRules) {
      const rs = hhmm(rule.start_time)
      const re = hhmm(rule.end_time)
      const roleIds = new Set((staff ?? []).filter(p => norm(p.job_title) === norm(rule.job_title)).map(p => p.id))

      // Shifts already in place that cover this requirement count towards it
      const covering = weekShifts.filter(s =>
        s.date === date && roleIds.has(s.staff_id) && !usedShiftIds.has(s.id) &&
        toMin(s.start_time) <= toMin(rs) && toMin(s.end_time) >= toMin(re)
      ).slice(0, rule.min_staff)
      covering.forEach(s => usedShiftIds.add(s.id))
      let needed = rule.min_staff - covering.length

      while (needed > 0) {
        const checks = await checkStaffForWindow(date, rs, re, rule.job_title, [])
        const pick = checks
          .filter(c => c.eligible && !bookedThatDay.has(`${c.id}|${date}`))
          .sort((a, b) => a.weekHours - b.weekHours)[0]
        if (!pick) break

        const { data: row } = await supabaseAdmin.from('shifts').insert({
          staff_id: pick.id, date, start_time: rs, end_time: re,
          status: 'scheduled', ai_generated: true, roster_run_id: runId,
        }).select('*').single()

        if (row) { weekShifts.push(row); usedShiftIds.add(row.id) }
        bookedThatDay.add(`${pick.id}|${date}`)
        added.push({ name: pick.full_name, date, start: rs, end: re })
        needed--
      }

      for (let i = 0; i < needed; i++) {
        gaps.push({ id: `G${gaps.length + 1}`, date, job_title: rule.job_title, start: rs, end: re })
      }
    }
  }

  // 4. Hand any gaps to the AI agent
  let agentSummary = `Drafted ${added.length} shifts. Every requirement this week is covered.`
  let agentUsed = false
  let steps: any[] = []

  if (gaps.length) {
    const agent = await runGapAgent(gaps, runId)
    if (agent) {
      agentUsed = true
      agentSummary = agent.summary
      steps = agent.steps
      added.push(...agent.added)
    } else {
      gaps.forEach(g => { g.status = 'left'; g.note = 'Nobody available for the whole shift (AI agent not available to try partial shifts).' })
      agentSummary = `Drafted ${added.length} shifts. ${gaps.length} could not be filled and need the manager.`
    }
  }

  return { runId, weekStart, weekEnd, added, gaps, agentSummary, agentUsed, steps }
}