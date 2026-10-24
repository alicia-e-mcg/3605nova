'use client'
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/lib/useProfile'
import StaffWindow from '@/components/StaffWindow'
import { toYMD, fromYMD, fmtDate } from '@/lib/dates'

type Flag = { id: number; date: string; reason: string | null }

const calendarStyle = {
  '--rdp-day-width': '40px',
  '--rdp-day-height': '40px',
  '--rdp-day_button-width': '38px',
  '--rdp-day_button-height': '38px',
  '--rdp-accent-color': '#2563eb',
  '--rdp-accent-background-color': '#dbeafe',
  fontSize: '14px',
} as CSSProperties

export default function Availability() {
  const me = useProfile()
  const [flags, setFlags] = useState<Flag[]>([])
  const [rosteredDates, setRosteredDates] = useState<string[]>([])
  const [selected, setSelected] = useState<Date[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!me) return
    const [{ data: u }, { data: s }] = await Promise.all([
      supabase.from('unavailability').select('id, date, reason').eq('staff_id', me.id).order('date'),
      supabase.from('shifts').select('date').eq('staff_id', me.id),
    ])
    setFlags(u ?? [])
    setRosteredDates((s ?? []).map(r => r.date))
  }, [me])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!me || selected.length === 0) return
    const dates = selected.map(toYMD).sort()

    // Warn if any of the chosen days already have a shift
    const clashes = dates.filter(d => rosteredDates.includes(d))
    if (clashes.length > 0 && !confirm(
      `You're rostered on ${clashes.map(fmtDate).join(', ')}. ` +
      `Flag ${clashes.length > 1 ? 'these days' : 'this day'} as unavailable anyway? ` +
      `Your manager will see you're unavailable.`
    )) return

    setBusy(true)
    const { error } = await supabase
      .from('unavailability')
      .insert(dates.map(date => ({ staff_id: me.id, date, reason: reason.trim() || null })))
    setBusy(false)

    if (error) { alert(error.message); return }
    setSelected([])
    setReason('')
    load()
  }

  async function removeFlag(id: number) {
    await supabase.from('unavailability').delete().eq('id', id)
    load()
  }

  if (!me) return null

  const today = toYMD(new Date())
  const startOfToday = fromYMD(today)
  const flaggedDates = flags.map(f => fromYMD(f.date))
  const upcoming = flags.filter(f => f.date >= today)
  const selectedSorted = [...selected].sort((a, b) => a.getTime() - b.getTime())

  return (
    <StaffWindow>
      <div className="grid gap-6 p-4 md:grid-cols-[auto_1fr]">

        {/* Left: choose days, add reason, save */}
        <section className="space-y-3">
          <div>
            <h1 className="text-lg font-semibold">Unavailable days</h1>
            <p className="text-sm text-gray-600">
              1. Select the days you can't work &nbsp;2. Add a reason &nbsp;3. Click Save
            </p>
          </div>

          <div className="rounded border border-gray-300 p-2">
            <DayPicker
              mode="multiple"
              selected={selected}
              onSelect={days => setSelected(days ?? [])}
              weekStartsOn={1}
              disabled={[{ before: startOfToday }, ...flaggedDates]}
              modifiers={{
                unavailable: flaggedDates,
                rostered: rosteredDates.map(fromYMD),
              }}
              modifiersStyles={{
                unavailable: { backgroundColor: '#fecaca', color: '#b91c1c', fontWeight: 600, borderRadius: '9999px', opacity: 1 },
                rostered: { boxShadow: 'inset 0 0 0 2px #94a3b8', borderRadius: '9999px' },
              }}
              style={calendarStyle}
            />
          </div>

          <div className="space-y-1 text-xs text-gray-600">
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-blue-600" /> Selected</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-200" /> Already flagged unavailable</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-slate-400" /> You're rostered</div>
          </div>

          <div className="space-y-3 rounded border border-gray-300 p-3">
            <div className="text-sm">
              <span className="font-medium">Selected: </span>
              {selectedSorted.length === 0
                ? <span className="text-gray-500">none yet</span>
                : selectedSorted.map(d => fmtDate(toYMD(d))).join(', ')}
            </div>

            <label className="block text-sm">
              Reason (optional)
              <input
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Uni exam, appointment"
                className="mt-1 w-full rounded border border-gray-300 p-1.5"
              />
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => { setSelected([]); setReason('') }}
                disabled={busy || selected.length === 0}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40"
              >
                Clear
              </button>
              <button
                onClick={save}
                disabled={busy || selected.length === 0}
                className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {busy ? 'Saving…' : `Save${selected.length ? ` ${selected.length} day${selected.length > 1 ? 's' : ''}` : ''}`}
              </button>
            </div>
          </div>
        </section>

        {/* Right: what's already flagged */}
        <section className="rounded border border-gray-300">
          <div className="border-b border-gray-300 px-3 py-2 font-semibold">My upcoming flags</div>
          {upcoming.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">No days flagged.</p>
          ) : (
            <ul>
              {upcoming.map(f => (
                <li key={f.id} className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{fmtDate(f.date)}</span>
                    {f.reason && <span className="ml-2 text-gray-500">— {f.reason}</span>}
                    {rosteredDates.includes(f.date) && <span className="ml-2 text-xs text-red-600">(rostered)</span>}
                  </span>
                  <button onClick={() => removeFlag(f.id)} className="text-xs text-gray-500 hover:text-red-600">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </StaffWindow>
  )
}