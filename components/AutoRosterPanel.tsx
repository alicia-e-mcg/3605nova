/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { callApi } from '@/lib/api'
import { fmtDate, fmtTime } from '@/lib/dates'

type Gap = {
  id: string; date: string; job_title: string; start: string; end: string
  status?: string; note?: string; parts?: { start: string; end: string; name: string }[]
}
type Result = {
  runId: string
  added: { name: string; date: string; start: string; end: string }[]
  gaps: Gap[]
  agentSummary: string
  agentUsed: boolean
  steps: { tool: string; args: any; result: any }[]
}

function describeStep(s: { tool: string; args: any; result: any }) {
  const a = s.args ?? {}
  const r = s.result ?? {}
  switch (s.tool) {
    case 'find_available_staff': {
      const ok = (r.staff ?? []).filter((x: any) => x.eligible).map((x: any) => x.name)
      return r.error ? `Check refused: ${r.error}` : `Checked ${a.gap_id} ${a.start_time}–${a.end_time}: ${ok.length ? ok.join(', ') : 'nobody eligible'}`
    }
    case 'add_shift':
      return r.error ? `Tried to add a shift. Refused: ${r.error}` : `Rostered ${r.name} ${a.start_time}–${a.end_time} for ${a.gap_id}`
    case 'leave_gap':
      return `Left ${a.gap_id} for the manager: ${a.reason}`
    case 'finish':
      return r.error ? `Tried to finish too early: ${r.error}` : 'Finished'
    default:
      return s.tool
  }
}

export default function AutoRosterPanel({ weekStart, onDone }: { weekStart: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [showSteps, setShowSteps] = useState(false)

  async function run() {
    if (!confirm('Draft a roster for this week? Existing and confirmed shifts are kept. Any earlier unconfirmed draft for this week is replaced.')) return
    setBusy(true)
    const res = await callApi('/api/roster/auto', { weekStart })
    setBusy(false)
    if (!res.ok) { alert(res.error ?? 'Something went wrong'); return }
    setResult(res as unknown as Result)
    setShowSteps(false)
    onDone()
  }

  async function confirmAll() {
    if (!result) return
    await supabase.from('shifts').update({ ai_generated: false }).eq('roster_run_id', result.runId).eq('ai_generated', true)
    setResult(null)
    onDone()
  }

  async function discard() {
    if (!result) return
    if (!confirm('Remove every shift in this draft?')) return
    await supabase.from('shifts').delete().eq('roster_run_id', result.runId).eq('ai_generated', true)
    setResult(null)
    onDone()
  }

  const left = result?.gaps.filter(g => g.status === 'left') ?? []
  const filledByAgent = result?.gaps.filter(g => g.status === 'filled') ?? []

  return (
    <>
      <button
        onClick={run}
        disabled={busy}
        className="flex items-center gap-1 rounded bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-60"
      >
        <Sparkles size={14} />
        {busy ? 'Rostering…' : 'Auto-roster week'}
      </button>

      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md bg-white p-5 text-sm shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Draft roster</h3>
              <button onClick={() => setResult(null)} aria-label="Close" className="text-gray-400 hover:text-gray-700">
                <X size={16} />
              </button>
            </div>

            <div className="mb-3 rounded border border-purple-200 bg-purple-50 p-3 text-purple-900">
              {result.agentSummary}
            </div>

            <p className="mb-2"><span className="font-medium">{result.added.length}</span> shifts drafted (shown in purple).</p>

            {filledByAgent.length > 0 && (
              <div className="mb-2">
                <div className="font-medium text-green-700">Gaps the agent solved</div>
                <ul className="ml-4 list-disc">
                  {filledByAgent.map(g => (
                    <li key={g.id}>
                      {fmtDate(g.date)} {g.job_title} {fmtTime(g.start)}–{fmtTime(g.end)}:{' '}
                      {(g.parts ?? []).map(p => `${p.name} ${fmtTime(p.start)}–${fmtTime(p.end)}`).join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {left.length > 0 && (
              <div className="mb-2">
                <div className="font-medium text-red-700">Needs you</div>
                <ul className="ml-4 list-disc">
                  {left.map(g => (
                    <li key={g.id}>
                      {fmtDate(g.date)} {g.job_title} {fmtTime(g.start)}–{fmtTime(g.end)}
                      {(g.parts ?? []).length > 0 && ` (partly filled: ${(g.parts ?? []).map(p => `${p.name} ${fmtTime(p.start)}–${fmtTime(p.end)}`).join(', ')})`}
                      {g.note && <div className="text-gray-600">{g.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.agentUsed && (
              <div className="mb-3">
                <button onClick={() => setShowSteps(!showSteps)} className="text-xs text-blue-600 hover:underline">
                  {showSteps ? 'Hide agent steps' : `Show agent steps (${result.steps.length})`}
                </button>
                {showSteps && (
                  <ol className="ml-5 mt-1 list-decimal space-y-0.5 text-xs text-gray-700">
                    {result.steps.map((s, i) => <li key={i}>{describeStep(s)}</li>)}
                  </ol>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-gray-200 pt-3">
              <button onClick={discard} className="rounded border border-gray-300 px-3 py-1.5 text-red-600 hover:bg-red-50">
                Discard draft
              </button>
              <button onClick={() => setResult(null)} className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">
                Review on roster
              </button>
              <button onClick={confirmAll} className="rounded bg-purple-600 px-3 py-1.5 font-medium text-white hover:bg-purple-700">
                Confirm all
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}