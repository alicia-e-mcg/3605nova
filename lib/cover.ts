// SERVER ONLY. Finds cover for shifts affected by sick calls or approved leave.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { fmtDate, fmtTime, sydneyToday } from '@/lib/dates'
import { checkStaffForWindow } from '@/lib/agent/rules'
import { runCoverAgent, type CoverOutcome } from '@/lib/agent/coverAgent'

export type Leave = { id: number; staff_id: string; start_date: string; end_date: string; type: string; status?: string }
type Shift = { id: number; staff_id: string; date: string; start_time: string; end_time: string; status: string }
type Profile = { id: string; full_name: string; job_title: string | null }

// Send an alert to every manager, optionally linked to the shift it's about
export async function alertManagers(body: string, shiftId?: number) {
  const { data: managers } = await supabaseAdmin.from('profiles').select('id').eq('role', 'manager')
  if (managers?.length) {
    await supabaseAdmin.from('messages').insert(
      managers.map(m => ({ recipient_id: m.id, body, from_ai: true, shift_id: shiftId ?? null }))
    )
  }
}

// Backup if the agent can't run: give the whole shift to whoever has the fewest hours
async function coverWithRules(shift: Shift, absent: Profile): Promise<CoverOutcome> {
  const checks = await checkStaffForWindow(
    shift.date, shift.start_time.slice(0, 5), shift.end_time.slice(0, 5), absent.job_title, [absent.id]
  )
  const eligible = checks.filter(c => c.eligible).sort((a, b) => a.weekHours - b.weekHours)

  if (eligible.length === 0) {
    const why = checks.length === 0
      ? `There are no other staff with the job title "${absent.job_title}" (check the spelling in profiles).`
      : checks.map(c => `${c.full_name} is ${c.reason}`).join('; ') + '.'
    return { covered: false, summary: why, coveredBy: [] }
  }

  const pick = eligible[0]
  await supabaseAdmin.from('shifts').update({ staff_id: pick.id, status: 'covered', ai_generated: true }).eq('id', shift.id)
  return {
    covered: true,
    summary: `I moved the shift to ${pick.full_name}, who has the fewest hours this week (${pick.weekHours}h). (Rules backup used because the AI agent was unavailable.)`,
    coveredBy: [pick.full_name],
  }
}

export async function coverShiftsForLeave(leave: Leave) {
  const { data: absent } = await supabaseAdmin
    .from('profiles').select('id, full_name, job_title').eq('id', leave.staff_id).single()
  if (!absent) return []

  const { data: shifts } = await supabaseAdmin
    .from('shifts').select('*')
    .eq('staff_id', leave.staff_id)
    .gte('date', leave.start_date)
    .lte('date', leave.end_date)
    .order('date')

  const reason = leave.type === 'sick' ? 'called in sick' : `is on ${leave.type} leave`

  if (!shifts?.length) {
    // Only announce "no shifts" if this request hasn't already had shifts moved earlier
    const { count } = await supabaseAdmin
      .from('shifts')
      .select('id', { count: 'exact', head: true })
      .eq('covered_for_leave_id', leave.id)
    if (!count) {
      await alertManagers(`${absent.full_name} ${reason} (${fmtDate(leave.start_date)}). They have no shifts in that period, so no roster changes were needed.`)
    }
    return []
  }

  const results: { shiftId: number; covered: boolean; coveredBy?: string }[] = []

  for (const shift of shifts) {
    await supabaseAdmin
      .from('shifts')
      .update({ status: 'needs_cover', original_staff_id: shift.staff_id, covered_for_leave_id: leave.id })
      .eq('id', shift.id)

    const when = `${fmtDate(shift.date)}, ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}`

    // Try the AI agent first; if it can't run, use the rules
    const outcome = (await runCoverAgent(shift, absent, leave)) ?? (await coverWithRules(shift, absent))

    if (outcome.covered) {
      await alertManagers(`${absent.full_name} ${reason} (${when}). ${outcome.summary}`, shift.id)
      results.push({ shiftId: shift.id, covered: true, coveredBy: outcome.coveredBy.join(' + ') })
    } else {
      await alertManagers(
        `Couldn't find cover: ${absent.full_name} ${reason} for ${when}. ${outcome.summary} Please arrange cover manually. The shift is marked red on the roster.`,
        shift.id
      )
      results.push({ shiftId: shift.id, covered: false })
    }
  }

  return results
}

// Undo cover when a request is withdrawn by staff or declined by the manager.
// Future shifts go back to the original person (split parts are removed); past shifts are left alone.
export async function undoCoverForLeave(leave: Leave, how: 'withdrawn' | 'declined') {
  const today = sydneyToday()

  const [{ data: absent }, { data: shifts }] = await Promise.all([
    supabaseAdmin.from('profiles').select('full_name').eq('id', leave.staff_id).single(),
    supabaseAdmin.from('shifts').select('*').eq('covered_for_leave_id', leave.id).gte('date', today).order('date'),
  ])

  // A pending request that never touched any shifts: nothing to undo, nothing to announce
  if (!shifts?.length && leave.status === 'pending') return

  // Who had been covering, so the manager can let them know
  const coverIds = [...new Set(
    (shifts ?? []).filter(s => s.staff_id !== s.original_staff_id).map(s => s.staff_id)
  )]
  const { data: coverStaff } = coverIds.length
    ? await supabaseAdmin.from('profiles').select('full_name').in('id', coverIds)
    : { data: [] as { full_name: string }[] }

  const lines: string[] = []
  for (const s of shifts ?? []) {
    // Extra parts created by a split are removed
    if (s.split_from_shift_id) {
      await supabaseAdmin.from('shifts').delete().eq('id', s.id)
      continue
    }

    const startTime = s.original_start_time ?? s.start_time
    const endTime = s.original_end_time ?? s.end_time
    lines.push(`${fmtDate(s.date)}, ${fmtTime(startTime)}–${fmtTime(endTime)}`)

    await supabaseAdmin
      .from('shifts')
      .update({
        staff_id: s.original_staff_id,
        start_time: startTime,
        end_time: endTime,
        status: 'scheduled',
        ai_generated: false,
        original_staff_id: null,
        original_start_time: null,
        original_end_time: null,
        covered_for_leave_id: null,
      })
      .eq('id', s.id)
  }

  const what = leave.type === 'sick' ? 'sick call' : `${leave.type} leave`
  const opening = how === 'declined'
    ? `You declined ${absent?.full_name}'s ${what}.`
    : `${absent?.full_name} withdrew their ${what}.`
  const noLongerNeeded = coverStaff?.length
    ? ` No longer needed as cover: ${coverStaff.map(p => p.full_name).join(', ')}.`
    : ''

  await alertManagers(
    lines.length
      ? `${opening} These shifts are back with them: ${lines.join('; ')}.${noLongerNeeded}`
      : `${opening} No upcoming shifts needed changing.`
  )
}