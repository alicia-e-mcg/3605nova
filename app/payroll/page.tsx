'use client'
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, Check, Sparkles } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useManager } from '@/lib/useManager'
import { callApi } from '@/lib/api'
import AppWindow from '@/components/AppWindow'
import { toYMD, fromYMD, fmtDate, sydneyToday } from '@/lib/dates'

type Settings = {
  saturday_multiplier: number; sunday_multiplier: number
  public_holiday_multiplier: number; overtime_multiplier: number
  weekly_ordinary_hours: number
}
type Run = {
  id: number; week_start: string; week_end: string
  status: 'draft' | 'confirmed'; ai_summary: string | null
  warnings: string[] | null; confirmed_at: string | null
}
type CatKey = 'ordinary_hours' | 'saturday_hours' | 'sunday_hours' | 'holiday_hours' | 'overtime_hours'
type Item = {
  id: number; run_id: number; staff_id: string; base_rate: number
  ordinary_hours: number; saturday_hours: number; sunday_hours: number
  holiday_hours: number; overtime_hours: number; gross_pay: number
  ai_note: string | null; manager_note: string | null
  edited: boolean; confirmed: boolean
  profiles: { full_name: string; job_title: string | null } | null
}

const CATS: { key: CatKey; label: string; mult: (s: Settings) => number }[] = [
  { key: 'ordinary_hours', label: 'Ordinary (Mon–Fri)', mult: () => 1 },
  { key: 'saturday_hours', label: 'Saturday', mult: s => Number(s.saturday_multiplier) },
  { key: 'sunday_hours', label: 'Sunday', mult: s => Number(s.sunday_multiplier) },
  { key: 'holiday_hours', label: 'Public holiday', mult: s => Number(s.public_holiday_multiplier) },
  { key: 'overtime_hours', label: 'Overtime', mult: s => Number(s.overtime_multiplier) },
]

const num = (v: unknown) => Number(v) || 0
const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })
const hoursOf = (i: Item) => round2(CATS.reduce((s, c) => s + num(i[c.key]), 0))
const grossOf = (i: Item, s: Settings) => round2(num(i.base_rate) * CATS.reduce((sum, c) => sum + num(i[c.key]) * c.mult(s), 0))

function addDaysYMD(ymd: string, n: number) {
  const d = fromYMD(ymd)
  d.setDate(d.getDate() + n)
  return toYMD(d)
}
function mondayOfYMD(ymd: string) {
  const d = fromYMD(ymd)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return toYMD(d)
}
const lastCompletedWeek = () => addDaysYMD(mondayOfYMD(sydneyToday()), -7)

export default function PayrollPage() {
  const ready = useManager()
  const [weekStart, setWeekStart] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState<string | null>(null) // staff_id open in the detail view
  const [draft, setDraft] = useState<Item | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesDraft, setRulesDraft] = useState<Settings | null>(null)

  // Start on the most recent finished week (set in the browser)
  useEffect(() => { setWeekStart(lastCompletedWeek()) }, [])

  const load = useCallback(async () => {
    if (!weekStart) return
    const [{ data: s }, { data: r }] = await Promise.all([
      supabase.from('pay_settings').select('*').eq('id', 1).single(),
      supabase.from('payroll_runs').select('*').eq('week_start', weekStart).maybeSingle(),
    ])
    setSettings(s)
    setRulesDraft(s)
    setRun(r ?? null)
    if (r) {
      const { data: it } = await supabase
        .from('payroll_items')
        .select('*, profiles(full_name, job_title)')
        .eq('run_id', r.id)
      setItems(((it ?? []) as unknown as Item[])
        .sort((a, b) => (a.profiles?.full_name ?? '').localeCompare(b.profiles?.full_name ?? '')))
    } else {
      setItems([])
    }
  }, [weekStart])

  useEffect(() => { if (ready) load() }, [ready, load])

  // Keep the detail form in step with the selected person
  useEffect(() => {
    const it = items.find(i => i.staff_id === selected)
    setDraft(it ? { ...it } : null)
  }, [selected, items])

  async function generate() {
    if (!weekStart) return
    setBusy(true)
    const res = await callApi('/api/payroll/generate', { weekStart })
    setBusy(false)
    if (!res.ok) { alert(res.error ?? 'Something went wrong'); return }
    setSelected(null)
    load()
  }

  async function saveItem(confirmIt: boolean) {
    if (!draft || !settings) return
    const original = items.find(i => i.id === draft.id)
    const changed = !!original && (
      num(original.base_rate) !== num(draft.base_rate) ||
      CATS.some(c => num(original[c.key]) !== num(draft[c.key]))
    )
    const { error } = await supabase.from('payroll_items').update({
      base_rate: num(draft.base_rate),
      ordinary_hours: num(draft.ordinary_hours),
      saturday_hours: num(draft.saturday_hours),
      sunday_hours: num(draft.sunday_hours),
      holiday_hours: num(draft.holiday_hours),
      overtime_hours: num(draft.overtime_hours),
      gross_pay: grossOf(draft, settings),
      manager_note: draft.manager_note,
      edited: draft.edited || changed,
      confirmed: confirmIt ? true : draft.confirmed,
    }).eq('id', draft.id)
    if (error) { alert(error.message); return }

    if (confirmIt) {
      // Move on to the next person still to confirm
      const next = items.find(i => !i.confirmed && i.id !== draft.id)
      setSelected(next ? next.staff_id : null)
    }
    load()
  }

  async function confirmPayroll() {
    if (!run) return
    if (items.some(i => !i.confirmed)) { alert('Confirm every worker first.'); return }
    if (!confirm('Confirm and lock payroll for this week? It can no longer be changed.')) return
    const { error } = await supabase.from('payroll_runs')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', run.id)
    if (error) { alert(error.message); return }
    setSelected(null)
    load()
  }

  async function saveRules() {
    if (!rulesDraft) return
    const { error } = await supabase.from('pay_settings').update({
      saturday_multiplier: num(rulesDraft.saturday_multiplier),
      sunday_multiplier: num(rulesDraft.sunday_multiplier),
      public_holiday_multiplier: num(rulesDraft.public_holiday_multiplier),
      overtime_multiplier: num(rulesDraft.overtime_multiplier),
      weekly_ordinary_hours: num(rulesDraft.weekly_ordinary_hours),
    }).eq('id', 1)
    if (error) { alert(error.message); return }
    setRulesOpen(false)
    load()
    alert('Pay rules saved. Click "Regenerate" on a draft week to apply them.')
  }

  if (!ready || !weekStart || !settings) return null

  const weekEnd = addDaysYMD(weekStart, 6)
  const canGoNext = addDaysYMD(weekStart, 7) <= lastCompletedWeek()
  const step = !run ? 1 : run.status === 'draft' ? 2 : 3
  const locked = run?.status === 'confirmed'
  const confirmedCount = items.filter(i => i.confirmed).length
  const totalWages = round2(items.reduce((s, i) => s + num(i.gross_pay), 0))
  const totalHours = round2(items.reduce((s, i) => s + hoursOf(i), 0))
  const visible = items.filter(i => (i.profiles?.full_name ?? '').toLowerCase().includes(search.toLowerCase()))

  return (
    <AppWindow>
      <div className="space-y-4 p-4">

        {/* Title, week picker and pay rules */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Payroll</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setWeekStart(addDaysYMD(weekStart, -7)); setSelected(null) }}
              aria-label="Previous week"
              className="rounded border border-gray-300 p-1 hover:bg-gray-100"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-medium">Week of {fmtDate(weekStart)} – {fmtDate(weekEnd)}</span>
            <button
              onClick={() => { setWeekStart(addDaysYMD(weekStart, 7)); setSelected(null) }}
              disabled={!canGoNext}
              aria-label="Next week"
              className="rounded border border-gray-300 p-1 hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
            <button onClick={() => setRulesOpen(!rulesOpen)} className="ml-2 text-xs text-blue-600 hover:underline">
              Pay rules
            </button>
          </div>
        </div>

        {/* Pay rules editor */}
        {rulesOpen && rulesDraft && (
          <div className="rounded border border-gray-300 p-3 text-sm">
            <div className="mb-2 font-semibold">Pay rules</div>
            <div className="flex flex-wrap gap-4">
              {([
                ['saturday_multiplier', 'Saturday ×'],
                ['sunday_multiplier', 'Sunday ×'],
                ['public_holiday_multiplier', 'Public holiday ×'],
                ['overtime_multiplier', 'Overtime ×'],
                ['weekly_ordinary_hours', 'Ordinary hours per week'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  {label}
                  <input
                    type="number" step="0.05"
                    value={rulesDraft[key]}
                    onChange={e => setRulesDraft({ ...rulesDraft, [key]: parseFloat(e.target.value) || 0 })}
                    className="mt-1 block w-24 rounded border border-gray-300 p-1"
                  />
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Set these from your award (e.g. the Fair Work pay guide for your staff&apos;s award).
            </p>
            <button onClick={saveRules} className="mt-2 rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700">
              Save pay rules
            </button>
          </div>
        )}

        {/* Progress: 1) hours 2) review 3) confirmation */}
        <div>
          <div className="h-2 overflow-hidden rounded bg-gray-200">
            <div className="h-full bg-blue-600 transition-all" style={{ width: `${(step / 3) * 100}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-xs">
            {['1) Hours', '2) Review', '3) Confirmation'].map((label, i) => (
              <span key={label} className={step >= i + 1 ? 'font-semibold text-blue-700' : 'text-gray-400'}>{label}</span>
            ))}
          </div>
        </div>

        {/* Step 1: not generated yet */}
        {!run && (
          <div className="rounded border border-gray-300 p-6 text-center">
            <p className="mb-1 font-medium">Payroll for this week hasn&apos;t been generated yet.</p>
            <p className="mb-4 text-sm text-gray-600">
              It&apos;s generated automatically every Monday morning once the week has finished. You can also generate it now.
            </p>
            <button
              onClick={generate}
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Calculating…' : 'Generate payroll'}
            </button>
          </div>
        )}

        {/* Steps 2 and 3: the payroll */}
        {run && (
          <>
            {run.ai_summary && (
              <div className="flex gap-2 rounded border border-purple-200 bg-purple-50 p-3 text-sm text-purple-900">
                <Sparkles size={16} className="mt-0.5 shrink-0" />
                <div><span className="font-semibold">AI check: </span>{run.ai_summary}</div>
              </div>
            )}
            {(run.warnings ?? []).length > 0 && (
              <ul className="list-disc rounded border border-amber-200 bg-amber-50 py-2 pl-8 pr-3 text-sm text-amber-900">
                {(run.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            {locked && (
              <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                Payroll confirmed{run.confirmed_at ? ` on ${new Date(run.confirmed_at).toLocaleDateString('en-AU')}` : ''}. This week is locked.
              </div>
            )}

            {/* Payroll dashboard table */}
            {!selected && (
              <div className="rounded border border-gray-300">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b-2 border-gray-400 text-left">
                      <th className="p-2 font-medium">Worker</th>
                      <th className="p-2 text-right font-medium">Hours</th>
                      <th className="p-2 text-right font-medium">Wages</th>
                      <th className="p-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(i => (
                      <tr
                        key={i.id}
                        onClick={() => setSelected(i.staff_id)}
                        className="cursor-pointer border-b border-gray-200 hover:bg-blue-50"
                      >
                        <td className="p-2">
                          <div className="font-medium">{i.profiles?.full_name}</div>
                          <div className="text-xs text-gray-500">{i.profiles?.job_title}</div>
                        </td>
                        <td className="p-2 text-right">{hoursOf(i)}h</td>
                        <td className="p-2 text-right">{money(num(i.gross_pay))}</td>
                        <td className="p-2 text-right">
                          {i.confirmed
                            ? <span className="inline-flex items-center gap-1 text-green-700"><Check size={14} /> Confirmed</span>
                            : <span className="text-amber-700">To review</span>}
                          {i.edited && <div className="text-xs text-gray-500">Edited</div>}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="p-2">Total</td>
                      <td className="p-2 text-right">{totalHours}h</td>
                      <td className="p-2 text-right">{money(totalWages)}</td>
                      <td className="p-2 text-right text-xs font-normal text-gray-500">{confirmedCount} of {items.length} confirmed</td>
                    </tr>
                  </tbody>
                </table>

                {!locked && (
                  <div className="flex justify-between border-t border-gray-300 p-3">
                    <button
                      onClick={() => { if (confirm('Recalculate this week from the roster? Your edits will be lost.')) generate() }}
                      disabled={busy}
                      className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50"
                    >
                      {busy ? 'Calculating…' : 'Regenerate'}
                    </button>
                    <button
                      onClick={confirmPayroll}
                      disabled={confirmedCount !== items.length || items.length === 0}
                      className="rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40"
                    >
                      Confirm payroll
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Payroll detail (wireframe 5) */}
            {selected && draft && (
              <div className="grid gap-4 md:grid-cols-[220px_1fr]">
                {/* Left: search and names */}
                <aside className="rounded border border-gray-300">
                  <div className="flex items-center gap-2 border-b border-gray-300 p-2">
                    <Search size={14} className="text-gray-400" />
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search"
                      className="w-full text-sm outline-none"
                    />
                  </div>
                  <ul>
                    {visible.map(i => (
                      <li key={i.id}>
                        <button
                          onClick={() => setSelected(i.staff_id)}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-100 ${i.staff_id === selected ? 'bg-blue-100 font-medium' : ''}`}
                        >
                          {i.profiles?.full_name}
                          {i.confirmed && <Check size={14} className="text-green-600" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button onClick={() => setSelected(null)} className="w-full border-t border-gray-300 p-2 text-left text-xs text-blue-600 hover:underline">
                    ← Back to payroll
                  </button>
                </aside>

                {/* Right: the person's details */}
                <section className="rounded border border-gray-300 p-4 text-sm">
                  <div className="mb-3 flex items-start justify-between">
                    <div>
                      <h2 className="text-base font-semibold">{draft.profiles?.full_name}</h2>
                      <div className="text-gray-500">{draft.profiles?.job_title}</div>
                    </div>
                    {draft.confirmed && <span className="inline-flex items-center gap-1 text-green-700"><Check size={14} /> Confirmed</span>}
                  </div>

                  {draft.ai_note && (
                    <div className="mb-3 flex gap-2 rounded bg-purple-50 p-2 text-purple-900">
                      <Sparkles size={14} className="mt-0.5 shrink-0" />
                      <span><span className="font-semibold">AI check: </span>{draft.ai_note}</span>
                    </div>
                  )}

                  <label className="mb-3 block">
                    Base rate ($/hour)
                    <input
                      type="number" step="0.01" disabled={locked}
                      value={draft.base_rate}
                      onChange={e => setDraft({ ...draft, base_rate: parseFloat(e.target.value) || 0 })}
                      className="ml-2 w-24 rounded border border-gray-300 p-1 disabled:bg-gray-100"
                    />
                  </label>

                  <table className="mb-3 w-full">
                    <thead>
                      <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                        <th className="pb-1 font-medium">Type</th>
                        <th className="pb-1 font-medium">Hours</th>
                        <th className="pb-1 text-right font-medium">Rate</th>
                        <th className="pb-1 text-right font-medium">Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {CATS.map(c => {
                        const rate = round2(num(draft.base_rate) * c.mult(settings))
                        return (
                          <tr key={c.key} className="border-b border-gray-100">
                            <td className="py-1">{c.label}</td>
                            <td className="py-1">
                              <input
                                type="number" step="0.25" min={0} disabled={locked}
                                value={draft[c.key]}
                                onChange={e => setDraft({ ...draft, [c.key]: parseFloat(e.target.value) || 0 })}
                                className="w-20 rounded border border-gray-300 p-1 disabled:bg-gray-100"
                              />
                            </td>
                            <td className="py-1 text-right text-gray-600">{money(rate)}/h</td>
                            <td className="py-1 text-right">{money(round2(num(draft[c.key]) * rate))}</td>
                          </tr>
                        )
                      })}
                      <tr className="font-semibold">
                        <td className="pt-2">Total</td>
                        <td className="pt-2">{hoursOf(draft)}h</td>
                        <td />
                        <td className="pt-2 text-right">{money(grossOf(draft, settings))}</td>
                      </tr>
                    </tbody>
                  </table>

                  <label className="mb-3 block">
                    Manager note
                    <textarea
                      rows={2} disabled={locked}
                      value={draft.manager_note ?? ''}
                      onChange={e => setDraft({ ...draft, manager_note: e.target.value })}
                      className="mt-1 w-full rounded border border-gray-300 p-1 disabled:bg-gray-100"
                    />
                  </label>

                  {!locked && (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => saveItem(false)} className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">
                        Save
                      </button>
                      <button onClick={() => saveItem(true)} className="rounded bg-blue-600 px-4 py-1.5 font-medium text-white hover:bg-blue-700">
                        Confirm
                      </button>
                    </div>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </AppWindow>
  )
}