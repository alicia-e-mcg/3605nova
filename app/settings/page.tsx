'use client'
import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useManager } from '@/lib/useManager'
import AppWindow from '@/components/AppWindow'

type Row = {
  key: string            // only used on this page
  day_of_week: number    // 0 = Sunday ... 6 = Saturday
  job_title: string
  start: string          // 'HH:MM'
  end: string            // 'HH:MM'
  min_staff: number
}

const DAYS = [
  { dow: 1, name: 'Monday' },
  { dow: 2, name: 'Tuesday' },
  { dow: 3, name: 'Wednesday' },
  { dow: 4, name: 'Thursday' },
  { dow: 5, name: 'Friday' },
  { dow: 6, name: 'Saturday' },
  { dow: 0, name: 'Sunday' },
]
const WEEKDAYS = [1, 2, 3, 4, 5]
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0]

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const dayName = (dow: number) => DAYS.find(d => d.dow === dow)?.name ?? ''

let counter = 0
const newKey = () => `row-${Date.now()}-${counter++}`

export default function StaffingNeeds() {
  const ready = useManager()
  const [rows, setRows] = useState<Row[]>([])
  const [titles, setTitles] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [{ data: r }, { data: p }] = await Promise.all([
      supabase.from('coverage_rules').select('*').order('day_of_week').order('start_time'),
      supabase.from('profiles').select('job_title').eq('role', 'staff'),
    ])
    setRows((r ?? []).map(x => ({
      key: newKey(),
      day_of_week: x.day_of_week,
      job_title: x.job_title ?? '',
      start: String(x.start_time).slice(0, 5),
      end: String(x.end_time).slice(0, 5),
      min_staff: x.min_staff ?? 1,
    })))
    setTitles([...new Set((p ?? []).map(x => (x.job_title ?? '').trim()).filter(Boolean))].sort())
    setDirty(false)
  }, [])

  useEffect(() => { if (ready) load() }, [ready, load])

  function update(key: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  function addRow(dow: number) {
    const last = [...rows].reverse().find(r => r.day_of_week === dow)
    setRows(prev => [...prev, {
      key: newKey(),
      day_of_week: dow,
      job_title: last?.job_title ?? titles[0] ?? '',
      start: '09:00',
      end: '17:00',
      min_staff: 1,
    }])
    setDirty(true)
  }

  function removeRow(key: string) {
    setRows(prev => prev.filter(r => r.key !== key))
    setDirty(true)
  }

  // Replaces the target days with a copy of one day's shifts
  function copyDay(fromDow: number, toDows: number[]) {
    const targets = toDows.filter(d => d !== fromDow)
    if (!confirm(`Replace ${targets.map(dayName).join(', ')} with ${dayName(fromDow)}'s shifts?`)) return
    setRows(prev => {
      const source = prev.filter(r => r.day_of_week === fromDow)
      const kept = prev.filter(r => !targets.includes(r.day_of_week))
      return [...kept, ...targets.flatMap(d => source.map(s => ({ ...s, key: newKey(), day_of_week: d })))]
    })
    setDirty(true)
  }

  async function save() {
    for (const r of rows) {
      if (!r.job_title.trim()) { alert(`${dayName(r.day_of_week)}: every shift needs a role.`); return }
      if (!r.start || !r.end || toMin(r.end) <= toMin(r.start)) {
        alert(`${dayName(r.day_of_week)}: the end time must be after the start time.`)
        return
      }
      if (!Number.isInteger(r.min_staff) || r.min_staff < 1) {
        alert(`${dayName(r.day_of_week)}: staff needed must be at least 1.`)
        return
      }
    }

    setSaving(true)
    const del = await supabase.from('coverage_rules').delete().gte('id', 0)
    if (del.error) { setSaving(false); alert(del.error.message); return }

    if (rows.length) {
      const ins = await supabase.from('coverage_rules').insert(rows.map(r => ({
        day_of_week: r.day_of_week,
        job_title: r.job_title.trim(),
        start_time: r.start,
        end_time: r.end,
        min_staff: r.min_staff,
      })))
      if (ins.error) { setSaving(false); alert(ins.error.message); return }
    }

    setSaving(false)
    await load()
    alert('Staffing needs saved. Auto-roster will use these from now on.')
  }

  if (!ready) return null

  const weeklyHours = rows.reduce(
    (sum, r) => sum + Math.max(0, (toMin(r.end) - toMin(r.start)) / 60) * (r.min_staff || 0),
    0
  )

  return (
    <AppWindow>
      <div className="space-y-4 p-4">

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Staffing needs</h1>
            <p className="text-sm text-gray-600">
              Set the shifts your practice needs each day and how many people for each. Auto-roster uses these.
            </p>
            <p className="mt-1 text-sm">
              Weekly staff hours needed: <span className="font-semibold">{+weeklyHours.toFixed(1)}h</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* Suggestions for the role box */}
        <datalist id="job-titles">
          {titles.map(t => <option key={t} value={t} />)}
        </datalist>

        {/* One card per day */}
        <div className="grid gap-4 md:grid-cols-2">
          {DAYS.map(({ dow, name }) => {
            const dayRows = rows.filter(r => r.day_of_week === dow)
            const isWeekday = WEEKDAYS.includes(dow)
            return (
              <section key={dow} className="rounded border border-gray-300">
                <div className="flex items-center justify-between border-b border-gray-300 bg-gray-50 px-3 py-2">
                  <h2 className="font-semibold">{name}</h2>
                  {dayRows.length > 0 && (
                    <div className="flex gap-3 text-xs">
                      {isWeekday && (
                        <button onClick={() => copyDay(dow, WEEKDAYS)} className="text-blue-600 hover:underline">
                          Copy to weekdays
                        </button>
                      )}
                      <button onClick={() => copyDay(dow, ALL_DAYS)} className="text-blue-600 hover:underline">
                        Copy to all days
                      </button>
                    </div>
                  )}
                </div>

                <div className="p-3">
                  {dayRows.length === 0 ? (
                    <p className="mb-2 text-sm text-gray-500">Closed — no staff needed.</p>
                  ) : (
                    <table className="mb-2 w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500">
                          <th className="pb-1 font-medium">Role</th>
                          <th className="pb-1 font-medium">From</th>
                          <th className="pb-1 font-medium">To</th>
                          <th className="pb-1 font-medium">Staff</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {dayRows.map(r => (
                          <tr key={r.key}>
                            <td className="pr-2 py-1">
                              <input
                                list="job-titles"
                                value={r.job_title}
                                onChange={e => update(r.key, { job_title: e.target.value })}
                                placeholder="e.g. Receptionist"
                                className="w-full rounded border border-gray-300 p-1"
                              />
                            </td>
                            <td className="pr-2 py-1">
                              <input
                                type="time" step={1800}
                                value={r.start}
                                onChange={e => update(r.key, { start: e.target.value })}
                                className="rounded border border-gray-300 p-1"
                              />
                            </td>
                            <td className="pr-2 py-1">
                              <input
                                type="time" step={1800}
                                value={r.end}
                                onChange={e => update(r.key, { end: e.target.value })}
                                className="rounded border border-gray-300 p-1"
                              />
                            </td>
                            <td className="pr-2 py-1">
                              <input
                                type="number" min={1} max={20}
                                value={r.min_staff}
                                onChange={e => update(r.key, { min_staff: parseInt(e.target.value || '0', 10) })}
                                className="w-16 rounded border border-gray-300 p-1"
                              />
                            </td>
                            <td className="py-1 text-right">
                              <button
                                onClick={() => removeRow(r.key)}
                                title="Remove this shift"
                                aria-label="Remove this shift"
                                className="text-gray-400 hover:text-red-600"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <button
                    onClick={() => addRow(dow)}
                    className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    <Plus size={14} /> Add shift
                  </button>
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </AppWindow>
  )
}