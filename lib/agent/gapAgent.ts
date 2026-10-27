/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER ONLY. An AI agent that tries to fill roster gaps the draft couldn't fill with one person.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { fmtDate } from '@/lib/dates'
import { checkStaffForWindow, isTime, toMin, MIN_SPLIT_HOURS, WEEKLY_HOUR_LIMIT } from '@/lib/agent/rules'
import { callAI, normalizeArgs } from '@/lib/agent/coverAgent'

export type Gap = {
  id: string
  date: string
  job_title: string
  start: string
  end: string
  status?: 'open' | 'filled' | 'left'
  note?: string
  parts?: { start: string; end: string; name: string }[]
}

export type AddedShift = { name: string; date: string; start: string; end: string }

const MAX_STEPS = 25
const TOTAL_TIMEOUT_MS = 90000

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_available_staff',
      description: 'Check who with the right job title can work a time window inside a gap. Returns each person, whether they are eligible, their hours this week, and the reason if not.',
      parameters: {
        type: 'object',
        properties: {
          gap_id: { type: 'string' },
          start_time: { type: 'string', description: 'HH:MM 24-hour, inside the gap' },
          end_time: { type: 'string', description: 'HH:MM 24-hour, inside the gap' },
        },
        required: ['gap_id', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_shift',
      description: `Roster an eligible person for all or part of a gap. Parts must be at least ${MIN_SPLIT_HOURS} hours and must not overlap parts already added to the same gap. Refused if the person is not eligible.`,
      parameters: {
        type: 'object',
        properties: {
          gap_id: { type: 'string' },
          staff_id: { type: 'string', description: 'A staff_id returned by find_available_staff' },
          start_time: { type: 'string', description: 'HH:MM 24-hour' },
          end_time: { type: 'string', description: 'HH:MM 24-hour' },
        },
        required: ['gap_id', 'staff_id', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leave_gap',
      description: 'Give up on a gap (or the rest of it) and tell the practice manager why.',
      parameters: {
        type: 'object',
        properties: {
          gap_id: { type: 'string' },
          reason: { type: 'string', description: 'Who you checked and why they could not do it' },
        },
        required: ['gap_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call once every gap is filled or left. Give a 2–3 sentence summary for the practice manager.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
]

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

// The parts of a gap that still need someone
function stillNeeded(g: Gap) {
  const parts = [...(g.parts ?? [])].sort((a, b) => toMin(a.start) - toMin(b.start))
  const out: string[] = []
  let cursor = toMin(g.start)
  for (const p of parts) {
    if (toMin(p.start) > cursor) out.push(`${hhmm(cursor)}-${p.start}`)
    cursor = Math.max(cursor, toMin(p.end))
  }
  if (cursor < toMin(g.end)) out.push(`${hhmm(cursor)}-${g.end}`)
  return out
}

// Returns null if the AI isn't configured (the gaps are then simply left for the manager)
export async function runGapAgent(gaps: Gap[], runId: string) {
  const token = process.env.AZURE_OPENAI_API_KEY
  if (!token || !process.env.AZURE_OPENAI_ENDPOINT) return null
  console.log(`Gap agent starting (${gaps.length} gaps)`)

  gaps.forEach(g => { g.status = 'open'; g.parts = [] })
  const steps: { tool: string; args: any; result: any }[] = []
  const added: AddedShift[] = []
  let summary = ''
  let finished = false

  async function runTool(name: string, args: Record<string, any>): Promise<any> {
    const g = gaps.find(x => x.id === args.gap_id)

    switch (name) {
      case 'find_available_staff': {
        if (!g) return { error: 'Unknown gap_id' }
        const ws = args.start_time, we = args.end_time
        if (!isTime(ws) || !isTime(we) || toMin(we) <= toMin(ws)) return { error: 'Times must be HH:MM, with end after start' }
        if (toMin(ws) < toMin(g.start) || toMin(we) > toMin(g.end)) return { error: `Stay inside the gap ${g.start}-${g.end}` }
        const checks = await checkStaffForWindow(g.date, ws, we, g.job_title, [])
        return {
          gap_id: g.id,
          window: `${ws}-${we}`,
          staff: checks.map(c => ({
            staff_id: c.id, name: c.full_name, hours_this_week: c.weekHours,
            eligible: c.eligible, reason: c.reason ?? null,
          })),
        }
      }

      case 'add_shift': {
        if (!g) return { error: 'Unknown gap_id' }
        if (g.status !== 'open') return { error: `Gap ${g.id} is already ${g.status}` }
        const ws = args.start_time, we = args.end_time
        if (!isTime(ws) || !isTime(we) || toMin(we) <= toMin(ws)) return { error: 'Times must be HH:MM, with end after start' }
        if (toMin(ws) < toMin(g.start) || toMin(we) > toMin(g.end)) return { error: `Stay inside the gap ${g.start}-${g.end}` }
        if ((toMin(we) - toMin(ws)) / 60 < MIN_SPLIT_HOURS) return { error: `Each part must be at least ${MIN_SPLIT_HOURS} hours` }
        if ((g.parts ?? []).some(p => toMin(p.start) < toMin(we) && toMin(p.end) > toMin(ws))) {
          return { error: 'That overlaps a part already added to this gap', still_needed: stillNeeded(g) }
        }

        const checks = await checkStaffForWindow(g.date, ws, we, g.job_title, [])
        const c = checks.find(x => x.id === args.staff_id)
        if (!c) return { error: 'Unknown staff_id. Only use ids returned by find_available_staff.' }
        if (!c.eligible) return { error: `${c.full_name} is not eligible: ${c.reason}` }

        const { error } = await supabaseAdmin.from('shifts').insert({
          staff_id: c.id, date: g.date, start_time: ws, end_time: we,
          status: 'scheduled', ai_generated: true, roster_run_id: runId,
        })
        if (error) return { error: `Could not save: ${error.message}` }

        g.parts!.push({ start: ws, end: we, name: c.full_name })
        added.push({ name: c.full_name, date: g.date, start: ws, end: we })
        const remaining = stillNeeded(g)
        if (remaining.length === 0) g.status = 'filled'
        return { ok: true, name: c.full_name, gap_status: g.status, still_needed: remaining }
      }

      case 'leave_gap': {
        if (!g) return { error: 'Unknown gap_id' }
        if (g.status !== 'open') return { error: `Gap ${g.id} is already ${g.status}` }
        g.status = 'left'
        g.note = String(args.reason ?? '')
        return { ok: true }
      }

      case 'finish': {
        const open = gaps.filter(x => x.status === 'open').map(x => x.id)
        if (open.length) return { error: `These gaps are still open: ${open.join(', ')}. Fill or leave them first.` }
        finished = true
        summary = String(args.summary ?? '')
        return { ok: true }
      }

      default:
        return { error: `Unknown tool ${name}` }
    }
  }

  const system = `You are a rostering agent for a small Australian GP clinic, working for the practice manager.
A draft roster for the week has been made, but some shifts could not be given to a single person. These are the gaps.
Your goal: fill as many gaps as possible without breaking rules. The tools enforce the rules: same job title, not unavailable or on leave, no clashing shift, at most ${WEEKLY_HOUR_LIMIT} hours a week.
For each gap:
1. Call find_available_staff for the whole gap.
2. If someone is eligible, add_shift for the whole gap (prefer fewest hours this week).
3. Otherwise try smaller windows (for example each half) and fill the gap in parts of at least ${MIN_SPLIT_HOURS} hours with different people.
4. If a gap (or what's left of it) can't be filled, call leave_gap and name who you checked and why.
When every gap is filled or left, call finish with a short summary for the manager.
Only use ids returned by the tools. Times are always HH:MM 24-hour.`

  const task = 'Unfilled gaps this week:\n' +
    gaps.map(g => `- ${g.id}: ${fmtDate(g.date)} (${g.date}), ${g.job_title}, ${g.start}-${g.end}`).join('\n')

  const messages: any[] = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ]
  let step = 0
  const deadline = Date.now() + TOTAL_TIMEOUT_MS

  try {
    while (step < MAX_STEPS && !finished && Date.now() < deadline) {
      const data = await callAI(
        { messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 },
        token
      )
      if (!data) break

      const msg = data?.choices?.[0]?.message
      if (!msg) break
      const calls = msg.tool_calls ?? []
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
      if (!calls.length) {
        if (!summary) summary = String(msg.content ?? '')
        break
      }

      for (const call of calls) {
        let args: any = {}
        try { args = JSON.parse(call.function?.arguments || '{}') } catch { args = {} }

        let result: any
        if (finished) {
          result = { error: 'Already finished' }
        } else {
          step++
          const cleanArgs = normalizeArgs(args)
          result = await runTool(call.function?.name, cleanArgs)
          steps.push({ tool: call.function?.name, args: cleanArgs, result })
          const { error } = await supabaseAdmin.from('agent_logs').insert({
            run_id: runId, step, tool: call.function?.name, args: cleanArgs, result,
          })
          if (error) console.error('Could not save agent step:', error.message)
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }
  } catch (err) {
    console.error('Gap agent stopped:', err)
  }

  // Anything still open is handed to the manager
  gaps.filter(g => g.status === 'open').forEach(g => {
    g.status = 'left'
    g.note = g.note || 'The agent ran out of time before finishing this gap.'
  })
  if (!summary) summary = 'The agent filled what it could. The remaining gaps need the manager.'

  return { summary, steps, added }
}