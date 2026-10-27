/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { fromYMD, fmtDate } from '@/lib/dates'

type AiAlert = {
  id: number
  body: string
  created_at: string
  shift_id: number | null
  shifts: { id: number; date: string; status: string; ai_generated: boolean } | null
}
type AgentStep = { id: number; step: number; tool: string; args: any; result: any }

type Props = {
  onChange: () => void            // reload the roster after confirming a shift
  onGoToDate: (d: Date) => void   // jump the calendar to a day
}

// Turns a logged tool call into a plain-English line
function describeStep(s: AgentStep) {
  const a = s.args ?? {}
  const r = s.result ?? {}
  switch (s.tool) {
    case 'get_day_roster':
      return `Looked at the day's roster (${r.shifts?.length ?? 0} shifts)`
    case 'find_available_staff': {
      const staff: any[] = r.staff ?? []
      const ok = staff.filter(x => x.eligible).map(x => x.name)
      return `Checked who can work ${a.start_time}–${a.end_time}: ${ok.length ? ok.join(', ') : 'nobody eligible'}`
    }
    case 'assign_shift':
      return r.error ? `Tried to assign the shift. Refused: ${r.error}` : 'Assigned the whole shift'
    case 'split_shift':
      return r.error ? `Tried to split the shift. Refused: ${r.error}` : `Split the shift into ${a.parts?.length ?? 2} parts`
    case 'escalate_to_manager':
      return 'Escalated to the manager'
    default:
      return s.tool
  }
}

export default function AlertsBell({ onChange, onGoToDate }: Props) {
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  const [open, setOpen] = useState(false)
  const [stepsFor, setStepsFor] = useState<number | null>(null)
  const [steps, setSteps] = useState<AgentStep[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('messages')
      .select('id, body, created_at, shift_id, shifts(id, date, status, ai_generated)')
      .eq('from_ai', true)
      .eq('recipient_id', user.id)
      .eq('dismissed', false)
      .order('created_at', { ascending: false })
      .limit(20)
    setAlerts((data ?? []) as unknown as AiAlert[])
  }, [])

  // Load now, then check for new alerts every 30 seconds
  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
  }, [load])

  // Close the dropdown when clicking outside it
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function dismiss(id: number) {
    setAlerts(prev => prev.filter(a => a.id !== id))
    await supabase.from('messages').update({ dismissed: true }).eq('id', id)
  }

  async function dismissAll() {
    const ids = alerts.map(a => a.id)
    setAlerts([])
    if (ids.length) await supabase.from('messages').update({ dismissed: true }).in('id', ids)
  }

  // Accept the AI's choice (including every part of a split) and close the alert
  async function confirmShift(a: AiAlert) {
    if (!a.shift_id) return
    const { error } = await supabase
      .from('shifts')
      .update({ ai_generated: false })
      .or(`id.eq.${a.shift_id},split_from_shift_id.eq.${a.shift_id}`)
    if (error) { alert(error.message); return }
    await dismiss(a.id)
    onChange()
  }

  function viewOnRoster(a: AiAlert) {
    if (!a.shifts) return
    onGoToDate(fromYMD(a.shifts.date))
    setOpen(false)
  }

  async function toggleSteps(a: AiAlert) {
    if (stepsFor === a.id) { setStepsFor(null); return }
    setStepsFor(a.id)
    setSteps([])
    if (!a.shift_id) return
    const { data } = await supabase
      .from('agent_logs')
      .select('id, step, tool, args, result')
      .eq('shift_id', a.shift_id)
      .order('created_at')
      .order('step')
    setSteps((data ?? []) as AgentStep[])
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => { if (!open) load(); setOpen(!open) }}
        title="AI alerts"
        aria-label="AI alerts"
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-gray-400 bg-white text-gray-700 hover:bg-gray-100"
      >
        <Bell size={18} />
        {alerts.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {alerts.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-96 max-w-[90vw] rounded-md border border-gray-300 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
            <span className="text-sm font-semibold">AI alerts</span>
            {alerts.length > 0 && (
              <button onClick={dismissAll} className="text-xs text-gray-500 hover:text-gray-800">Dismiss all</button>
            )}
          </div>

          {alerts.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">You&apos;re all caught up.</p>
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto">
              {alerts.map(a => {
                const s = a.shifts
                const canConfirm = !!s && s.ai_generated
                const needsCover = !!s && s.status === 'needs_cover'
                return (
                  <li
                    key={a.id}
                    className={`relative border-b border-gray-100 px-3 py-3 pr-8 text-sm ${needsCover ? 'bg-red-50' : canConfirm ? 'bg-purple-50' : ''}`}
                  >
                    <button
                      onClick={() => dismiss(a.id)}
                      title="Dismiss"
                      aria-label="Dismiss"
                      className="absolute right-2 top-2 text-gray-400 hover:text-gray-700"
                    >
                      <X size={14} />
                    </button>

                    <div className="mb-1 text-[11px] text-gray-500">
                      {new Date(a.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <p className="text-gray-800">{a.body}</p>

                    {s && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {canConfirm && (
                          <button
                            onClick={() => confirmShift(a)}
                            className="rounded bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-700"
                          >
                            Confirm shift
                          </button>
                        )}
                        <button
                          onClick={() => viewOnRoster(a)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100"
                        >
                          View {fmtDate(s.date)} on roster
                        </button>
                        <button
                          onClick={() => toggleSteps(a)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100"
                        >
                          {stepsFor === a.id ? 'Hide agent steps' : 'Show agent steps'}
                        </button>
                      </div>
                    )}

                    {stepsFor === a.id && (
                      <ol className="mt-2 list-decimal space-y-1 rounded bg-white/70 py-2 pl-6 pr-2 text-xs text-gray-700">
                        {steps.length === 0
                          ? <li className="list-none text-gray-500">No agent steps (the rules backup handled this one).</li>
                          : steps.map(st => <li key={st.id}>{describeStep(st)}</li>)}
                      </ol>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}