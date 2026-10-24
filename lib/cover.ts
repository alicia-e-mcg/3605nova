// SERVER ONLY. Finds cover for shifts affected by sick calls or approved leave.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { toYMD, fromYMD, fmtDate, fmtTime, sydneyToday } from '@/lib/dates'

const WEEKLY_HOUR_LIMIT = 38 // standard full-time hours in Australia
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

type Leave = { id: number; staff_id: string; start_date: string; end_date: string; type: string }
type Shift = { id: number; staff_id: string; date: string; start_time: string; end_time: string; status: string }
type Profile = { id: string; full_name: string; job_title: string | null }
type Candidate = Profile & { weekHours: number }

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const shiftHours = (s: { start_time: string; end_time: string }) => (toMin(s.end_time) - toMin(s.start_time)) / 60

// Monday to Sunday of the week containing this date
function weekRange(ymd: string) {
  const d = fromYMD(ymd)
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return [toYMD(monday), toYMD(sunday)]
}

// Send an alert to every manager, optionally linked to the shift it's about
export async function alertManagers(body: string, shiftId?: number) {  const { data: managers } = await supabaseAdmin.from('profiles').select('id').eq('role', 'manager')
  if (managers?.length) {
    await supabaseAdmin.from('messages').insert(
      managers.map(m => ({ recipient_id: m.id, body, from_ai: true, shift_id: shiftId ?? null }))
    )
  }
}

type Excluded = { name: string; reason: string }

// Compare job titles ignoring capitals and extra spaces
const norm = (s: string | null) => (s ?? '').trim().toLowerCase()

// Rules: same role, not unavailable or on leave, no clashing shift, won't go over weekly hours.
// Also records why anyone was skipped, so the manager's alert can explain it.
async function findCandidates(shift: Shift, absent: Profile) {
  const [weekStart, weekEnd] = weekRange(shift.date)
  const [{ data: staff }, { data: unavail }, { data: leave }, { data: weekShifts }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, full_name, job_title').eq('role', 'staff').neq('id', absent.id),
    supabaseAdmin.from('unavailability').select('staff_id').eq('date', shift.date),
    supabaseAdmin.from('leave_requests').select('staff_id')
      .eq('status', 'approved').lte('start_date', shift.date).gte('end_date', shift.date),
    supabaseAdmin.from('shifts').select('*').gte('date', weekStart).lte('date', weekEnd),
  ])

  const sameRole = (staff ?? []).filter(p => !absent.job_title || norm(p.job_title) === norm(absent.job_title))
  const unavailIds = new Set((unavail ?? []).map(r => r.staff_id))
  const leaveIds = new Set((leave ?? []).map(r => r.staff_id))
  const start = toMin(shift.start_time)
  const end = toMin(shift.end_time)
  const hoursNeeded = shiftHours(shift)

  const candidates: Candidate[] = []
  const excluded: Excluded[] = []

  for (const p of sameRole) {
    if (unavailIds.has(p.id)) { excluded.push({ name: p.full_name, reason: 'flagged unavailable that day' }); continue }
    if (leaveIds.has(p.id)) { excluded.push({ name: p.full_name, reason: 'on approved leave that day' }); continue }

    const clash = (weekShifts ?? []).find(s =>
      s.staff_id === p.id && s.date === shift.date && s.id !== shift.id &&
      toMin(s.start_time) < end && toMin(s.end_time) > start
    )
    if (clash) {
      excluded.push({ name: p.full_name, reason: `already working ${fmtTime(clash.start_time)}–${fmtTime(clash.end_time)} that day` })
      continue
    }

    const weekHours = (weekShifts ?? []).filter(s => s.staff_id === p.id).reduce((sum, s) => sum + shiftHours(s), 0)
    if (weekHours + hoursNeeded > WEEKLY_HOUR_LIMIT) {
      excluded.push({ name: p.full_name, reason: `already on ${weekHours}h this week, so this shift would take them over ${WEEKLY_HOUR_LIMIT}h` })
      continue
    }

    candidates.push({ ...p, weekHours })
  }

  candidates.sort((a, b) => a.weekHours - b.weekHours)
  return { candidates, excluded, sameRoleCount: sameRole.length }
}

// Gemini (free tier) picks from the candidate list only.
// Falls back to fewest hours if there's no key, the free limit is hit, or anything fails.
async function pickWithAI(shift: Shift, absent: Profile, candidates: Candidate[]) {
  const fallback = {
    staff_id: candidates[0].id,
    reason: `${candidates[0].full_name} has the fewest hours this week (${candidates[0].weekHours}h).`,
  }
  if (!process.env.GEMINI_API_KEY) return fallback

  const prompt = `You are helping roster staff at a small Australian GP clinic.
${absent.full_name} (${absent.job_title ?? 'staff'}) can't work their shift on ${fmtDate(shift.date)} from ${fmtTime(shift.start_time)} to ${fmtTime(shift.end_time)}.

These staff have the same role, are available, and would not go over ${WEEKLY_HOUR_LIMIT} hours this week:
${candidates.map(c => `- id: ${c.id} | ${c.full_name} | ${c.weekHours} hours already rostered this week`).join('\n')}

Choose the best person to cover the shift. Spread hours fairly and avoid overtime.
Reply with only JSON in exactly this format:
{"staff_id": "<an id from the list>", "reason": "<one short sentence for the practice manager>"}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    )
    if (!res.ok) {
      console.error('Gemini error', res.status, await res.text())
      return fallback
    }

    const data = await res.json()
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))

    // Only accept an answer that's actually on the list
    if (candidates.some(c => c.id === json.staff_id)) {
      return { staff_id: json.staff_id as string, reason: String(json.reason ?? '') }
    }
  } catch (err) {
    console.error('AI pick failed, using fallback:', err)
  }
  return fallback
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
    const { candidates, excluded, sameRoleCount } = await findCandidates(shift, absent)

    if (candidates.length === 0) {
      const why = sameRoleCount === 0
        ? `There are no other staff with the job title "${absent.job_title}" (check the spelling in profiles)`
        : excluded.map(e => `${e.name} is ${e.reason}`).join('; ')
      await alertManagers(
        `Couldn't find cover: ${absent.full_name} ${reason} for ${when}. ${why}. Please arrange cover manually. The shift is marked red on the roster.`,
        shift.id
      )
      results.push({ shiftId: shift.id, covered: false })
      continue
    }

    const choice = await pickWithAI(shift, absent, candidates)
    const chosen = candidates.find(c => c.id === choice.staff_id)!
    await supabaseAdmin
      .from('shifts')
      .update({ staff_id: chosen.id, status: 'covered', ai_generated: true })
      .eq('id', shift.id)

    await alertManagers(
      `${absent.full_name} ${reason}. I've moved their shift on ${when} to ${chosen.full_name}. ${choice.reason}`,
      shift.id
    )
    results.push({ shiftId: shift.id, covered: true, coveredBy: chosen.full_name })
  }

  return results
}

// Undo cover when a request is withdrawn by staff or declined by the manager.
// Future shifts go back to the original person; past shifts are left alone.
export async function undoCoverForLeave(leave: Leave & { status?: string }, how: 'withdrawn' | 'declined') {
  const today = sydneyToday()

  const [{ data: absent }, { data: shifts }] = await Promise.all([
    supabaseAdmin.from('profiles').select('full_name').eq('id', leave.staff_id).single(),
    supabaseAdmin.from('shifts').select('*').eq('covered_for_leave_id', leave.id).gte('date', today).order('date'),
  ])

  // A pending request that never touched any shifts: nothing to undo, nothing to announce
  if (!shifts?.length && leave.status === 'pending') return

  // Work out who had been covering, so the manager can let them know
  const coverIds = [...new Set(
    (shifts ?? []).filter(s => s.staff_id !== s.original_staff_id).map(s => s.staff_id)
  )]
  const { data: coverStaff } = coverIds.length
    ? await supabaseAdmin.from('profiles').select('id, full_name').in('id', coverIds)
    : { data: [] as { id: string; full_name: string }[] }
  const nameOf = (id: string) => coverStaff?.find(p => p.id === id)?.full_name ?? 'someone'

  const lines: string[] = []
  for (const s of shifts ?? []) {
    const when = `${fmtDate(s.date)}, ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`
    if (s.staff_id !== s.original_staff_id) lines.push(`${when} (was covered by ${nameOf(s.staff_id)})`)
    else lines.push(`${when} (was waiting for cover)`)

    await supabaseAdmin
      .from('shifts')
      .update({
        staff_id: s.original_staff_id,
        status: 'scheduled',
        ai_generated: false,
        original_staff_id: null,
        covered_for_leave_id: null,
      })
      .eq('id', s.id)
  }

  const what = leave.type === 'sick' ? 'sick call' : `${leave.type} leave`
  const opening = how === 'declined'
    ? `You declined ${absent?.full_name}'s ${what}.`
    : `${absent?.full_name} withdrew their ${what}.`
  await alertManagers(
    lines.length
      ? `${opening} These shifts are back with them: ${lines.join('; ')}. Let any cover staff know they're no longer needed.`
      : `${opening} No upcoming shifts needed changing.`
  )
}