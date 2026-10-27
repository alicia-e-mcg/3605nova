/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER ONLY. An AI agent that tries to get one shift covered by choosing and using tools.
// Runs on an OpenAI model through GitHub Models (Microsoft).
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { fmtDate, fmtTime } from '@/lib/dates'
import { checkStaffForWindow, hoursBetween, isTime, toMin, MIN_SPLIT_HOURS, WEEKLY_HOUR_LIMIT } from '@/lib/agent/rules'

// Azure OpenAI (Microsoft)
const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '')
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4-1-mini'
const AI_URL = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=2024-10-21`
export const AI_MODEL = AZURE_DEPLOYMENT

const MAX_STEPS = 8
const STEP_TIMEOUT_MS = 20000   // give up on a single AI call after 20 seconds
const TOTAL_TIMEOUT_MS = 45000  // give up on the whole agent after 45 seconds, then use the rules backup

type Shift = { id: number; staff_id: string; date: string; start_time: string; end_time: string; status: string }
type Profile = { id: string; full_name: string; job_title: string | null }
type Leave = { id: number; type: string }

export type CoverOutcome = { covered: boolean; summary: string; coveredBy: string[] }

// ---------- The tools the agent is allowed to use ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_day_roster',
      description: 'List every shift on the same date as the shift being covered, with staff names, roles and times.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_available_staff',
      description: 'Check which staff with the same job title can work a time window on the shift date. Returns everyone with that role, whether they are eligible, their hours this week, and the reason if not. Check the full shift first; check smaller windows when planning a split.',
      parameters: {
        type: 'object',
        properties: {
          start_time: { type: 'string', description: 'Start time, HH:MM 24-hour' },
          end_time: { type: 'string', description: 'End time, HH:MM 24-hour' },
        },
        required: ['start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_shift',
      description: 'Give the whole shift to one eligible staff member. Refused if they are not eligible.',
      parameters: {
        type: 'object',
        properties: {
          staff_id: { type: 'string', description: 'A staff_id returned by find_available_staff' },
          reason: { type: 'string', description: 'One short sentence for the practice manager explaining the choice' },
        },
        required: ['staff_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'split_shift',
      description: `Split the shift between 2 or 3 different eligible staff when nobody can work all of it. Parts must be in time order, join up with no gaps, cover the whole shift exactly, and each be at least ${MIN_SPLIT_HOURS} hours. Refused if any part breaks the rules.`,
      parameters: {
        type: 'object',
        properties: {
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                staff_id: { type: 'string' },
                start_time: { type: 'string', description: 'HH:MM 24-hour' },
                end_time: { type: 'string', description: 'HH:MM 24-hour' },
              },
              required: ['staff_id', 'start_time', 'end_time'],
            },
          },
          reason: { type: 'string', description: 'One short sentence for the practice manager explaining the split' },
        },
        required: ['parts', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_manager',
      description: 'Use only when no assignment or split is possible. Tells the practice manager why.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why cover could not be found, naming who was checked' } },
        required: ['reason'],
      },
    },
  },
]

// ---------- Helpers ----------

// Calls GitHub Models, retrying up to twice if it's busy (503) or rate-limited (429)
export async function callAI(body: unknown, token: string): Promise<any | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      })

      const text = await res.text()

      if (res.ok) {
        try {
          return JSON.parse(text)
        } catch {
          console.error('AI (github) sent back something that is not JSON:', text.slice(0, 300))
          return null
        }
      }

      if ((res.status === 503 || res.status === 429) && attempt < 3) {
        console.warn(`AI (github) busy (${res.status}), retrying in ${attempt * 2}s...`)
        await new Promise(r => setTimeout(r, attempt * 2000))
        continue
      }
      console.error('AI (github) error', res.status, text.slice(0, 800))
      return null
    } catch (err) {
      console.error('AI (github) call failed:', err)
      if (attempt === 3) return null
    }
  }
  return null
}

// Tidies times like "9:00" or "09:00:00" into "09:00"
function normTime(t: unknown): unknown {
  if (typeof t !== 'string') return t
  const m = t.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t
}
export function normalizeArgs(args: any) {
  const a = { ...(args ?? {}) }
  if ('start_time' in a) a.start_time = normTime(a.start_time)
  if ('end_time' in a) a.end_time = normTime(a.end_time)
  if (Array.isArray(a.parts)) {
    a.parts = a.parts.map((p: any) => ({ ...p, start_time: normTime(p?.start_time), end_time: normTime(p?.end_time) }))
  }
  return a
}

// ---------- The agent ----------

// Returns the outcome, or null if the agent couldn't run (no token, AI error, timeout, or it didn't finish),
// in which case the caller falls back to the simple rules.
export async function runCoverAgent(shift: Shift, absent: Profile, leave: Leave): Promise<CoverOutcome | null> {
  const token = process.env.AZURE_OPENAI_API_KEY
  if (!token || !AZURE_ENDPOINT) {
    console.error('Cover agent: AZURE_OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT is missing, using rules backup')
    return null
  }
  console.log(`Cover agent starting (azure, ${AI_MODEL})`)

  const start = shift.start_time.slice(0, 5)
  const end = shift.end_time.slice(0, 5)
  const state = { done: false, covered: false, summary: '', coveredBy: [] as string[] }

  async function runTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'get_day_roster': {
        const { data } = await supabaseAdmin
          .from('shifts')
          .select('start_time, end_time, status, profiles!shifts_staff_id_fkey(full_name, job_title)')
          .eq('date', shift.date)
          .order('start_time')
        return {
          shifts: (data ?? []).map((s: any) => ({
            name: s.profiles?.full_name, role: s.profiles?.job_title,
            start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), status: s.status,
          })),
        }
      }

      case 'find_available_staff': {
        const ws = args.start_time, we = args.end_time
        if (!isTime(ws) || !isTime(we) || toMin(we) <= toMin(ws)) return { error: 'Times must be HH:MM, with end after start' }
        const checks = await checkStaffForWindow(shift.date, ws, we, absent.job_title, [absent.id])
        return {
          window: `${ws}-${we}`,
          staff: checks.map(c => ({
            staff_id: c.id, name: c.full_name, hours_this_week: c.weekHours,
            eligible: c.eligible, reason: c.reason ?? null,
          })),
        }
      }

      case 'assign_shift': {
        if (state.done) return { error: 'Already finished' }
        const checks = await checkStaffForWindow(shift.date, start, end, absent.job_title, [absent.id])
        const c = checks.find(x => x.id === args.staff_id)
        if (!c) return { error: 'Unknown staff_id. Only use ids returned by find_available_staff.' }
        if (!c.eligible) return { error: `${c.full_name} is not eligible: ${c.reason}` }

        await supabaseAdmin.from('shifts').update({ staff_id: c.id, status: 'covered', ai_generated: true }).eq('id', shift.id)
        Object.assign(state, {
          done: true, covered: true, coveredBy: [c.full_name],
          summary: `I moved the shift to ${c.full_name}. ${args.reason ?? ''}`.trim(),
        })
        return { ok: true }
      }

      case 'split_shift': {
        if (state.done) return { error: 'Already finished' }
        const raw = Array.isArray(args.parts) ? args.parts : []
        if (raw.length < 2 || raw.length > 3) return { error: 'A split needs 2 or 3 parts' }
        if (raw.some((p: any) => typeof p?.staff_id !== 'string' || !isTime(p?.start_time) || !isTime(p?.end_time))) {
          return { error: 'Each part needs staff_id, start_time and end_time (HH:MM)' }
        }
        const parts = raw as { staff_id: string; start_time: string; end_time: string }[]

        if (parts[0].start_time !== start || parts[parts.length - 1].end_time !== end) {
          return { error: `Parts must start at ${start} and finish at ${end}` }
        }
        for (let i = 0; i < parts.length; i++) {
          if (hoursBetween(parts[i].start_time, parts[i].end_time) < MIN_SPLIT_HOURS) {
            return { error: `Each part must be at least ${MIN_SPLIT_HOURS} hours` }
          }
          if (i > 0 && parts[i].start_time !== parts[i - 1].end_time) {
            return { error: 'Parts must join up with no gaps or overlaps' }
          }
        }
        if (new Set(parts.map(p => p.staff_id)).size !== parts.length) return { error: 'Use a different person for each part' }

        // Every part must pass the rules before anything is changed
        const names: string[] = []
        for (const p of parts) {
          const checks = await checkStaffForWindow(shift.date, p.start_time, p.end_time, absent.job_title, [absent.id])
          const c = checks.find(x => x.id === p.staff_id)
          if (!c) return { error: `Unknown staff_id ${p.staff_id}` }
          if (!c.eligible) return { error: `${c.full_name} can't do ${p.start_time}–${p.end_time}: ${c.reason}` }
          names.push(c.full_name)
        }

        // All valid: the original shift becomes part 1, the other parts become new shifts
        const [first, ...rest] = parts
        await supabaseAdmin.from('shifts').update({
          staff_id: first.staff_id, start_time: first.start_time, end_time: first.end_time,
          status: 'covered', ai_generated: true,
          original_start_time: start, original_end_time: end,
        }).eq('id', shift.id)

        await supabaseAdmin.from('shifts').insert(rest.map(p => ({
          staff_id: p.staff_id, date: shift.date, start_time: p.start_time, end_time: p.end_time,
          status: 'covered', ai_generated: true,
          original_staff_id: absent.id, covered_for_leave_id: leave.id, split_from_shift_id: shift.id,
        })))

        const desc = parts.map((p, i) => `${names[i]} ${fmtTime(p.start_time)}–${fmtTime(p.end_time)}`).join(', ')
        Object.assign(state, {
          done: true, covered: true, coveredBy: names,
          summary: `Nobody could work the whole shift, so I split it: ${desc}. ${args.reason ?? ''}`.trim(),
        })
        return { ok: true }
      }

      case 'escalate_to_manager': {
        Object.assign(state, { done: true, covered: false, summary: String(args.reason ?? 'No valid cover was found.') })
        return { ok: true }
      }

      default:
        return { error: `Unknown tool ${name}` }
    }
  }

  const system = `You are a rostering agent for a small Australian GP clinic, working for the practice manager.
Your goal: get the shift below covered without breaking any rules. The tools enforce the rules: same job title, not unavailable or on leave, no clashing shift, at most ${WEEKLY_HOUR_LIMIT} hours a week.
How to work:
1. Call find_available_staff for the full shift.
2. If anyone is eligible, call assign_shift for the fairest choice (usually fewest hours this week).
3. If nobody can do the whole shift, use get_day_roster and find_available_staff on smaller windows to plan a split, then call split_shift.
4. If nothing works, call escalate_to_manager and name who you checked and why they couldn't.
Always act by calling a tool. Only use staff_ids returned by the tools. Times are always HH:MM 24-hour. If a tool refuses, read the error and try something else.`

  const task = `${absent.full_name} (${absent.job_title ?? 'staff'}) ${leave.type === 'sick' ? 'called in sick' : `is on ${leave.type} leave`}. ` +
    `Their shift needs cover: ${fmtDate(shift.date)} (${shift.date}), ${start}–${end}.`

  const messages: any[] = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ]
  let step = 0
  const deadline = Date.now() + TOTAL_TIMEOUT_MS

  try {
    while (step < MAX_STEPS && !state.done && Date.now() < deadline) {
      const data = await callAI(
        { model: AI_MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 },
        token
      )
      if (!data) break

      const msg = data?.choices?.[0]?.message
      if (!msg) { console.error('Agent got an empty reply:', JSON.stringify(data).slice(0, 500)); break }

      const calls = msg.tool_calls ?? []
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
      if (!calls.length) {
        console.error('Agent replied without using a tool:', String(msg.content ?? '').slice(0, 500))
        break
      }

      // Every tool call needs an answer, even if the agent already finished
      for (const call of calls) {
        let args: any = {}
        try { args = JSON.parse(call.function?.arguments || '{}') } catch { args = {} }

        let result: any
        if (state.done) {
          result = { error: 'Already finished' }
        } else {
          step++
          const cleanArgs = normalizeArgs(args)
          result = await runTool(call.function?.name, cleanArgs)
          const { error } = await supabaseAdmin.from('agent_logs').insert({
            shift_id: shift.id, leave_id: leave.id, step, tool: call.function?.name, args: cleanArgs, result,
          })
          if (error) console.error('Could not save agent step:', error.message)
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }
  } catch (err) {
    console.error('Agent stopped (timeout or error):', err)
  }

  if (!state.done && Date.now() >= deadline) console.error('Agent ran out of time, using rules backup')

  // If it acted (assigned, split or escalated), use that. Otherwise fall back to the rules.
  return state.done ? { covered: state.covered, summary: state.summary, coveredBy: state.coveredBy } : null
}