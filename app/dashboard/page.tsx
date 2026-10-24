'use client'
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { supabase } from '@/lib/supabase'
import { useManager } from '@/lib/useManager'
import AppWindow from '@/components/AppWindow'
import RequestsPanel from '@/components/RequestsPanel'

type Profile = { id: string; full_name: string; job_title: string | null }
type Shift = {
  id: number; staff_id: string; date: string
  start_time: string; end_time: string
  status: string; ai_generated: boolean
}
type Cell =
  | { kind: 'empty'; t: number }
  | { kind: 'block'; t: number; span: number; shift: Shift }
  | { kind: 'skip' }
type Menu = { x: number; y: number; staffId: string; t: number; shift?: Shift }
type Editing = { staffId: string; shiftId?: number; start: string; end: string }

// Grid runs 7am to 7pm in 30-minute slots
const DAY_START = 7 * 60
const DAY_END = 19 * 60
const SLOT = 30
const SLOTS = Array.from({ length: (DAY_END - DAY_START) / SLOT }, (_, i) => DAY_START + i * SLOT)

// Date as YYYY-MM-DD in Sydney local time (not UTC)
function toYMD(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const toMin = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m }
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
function fmt(min: number) {
  const h = Math.floor(min / 60), m = min % 60
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`
}

function shiftColour(s: Shift) {
  if (s.status === 'needs_cover') return 'bg-red-200 border-l-4 border-red-500'
  if (s.ai_generated) return 'bg-purple-200 border-l-4 border-purple-500'
  return 'bg-slate-300 border-l-4 border-slate-500'
}

export default function Dashboard() {
  const ready = useManager()
  const [date, setDate] = useState<Date | null>(null)
  const [month, setMonth] = useState<Date | undefined>(undefined)

  // Set today's date in the browser (not during the server pre-build)
  useEffect(() => {
    const now = new Date()
    setDate(now)
    setMonth(now)
  }, [])
  const [staff, setStaff] = useState<Profile[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [availableOnly, setAvailableOnly] = useState(false) // "tick box to show only available ppl"
  const [menu, setMenu] = useState<Menu | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)


  // Remember which staff are ticked, even after refreshing or changing days
  useEffect(() => {
    try {
      const saved = localStorage.getItem('roster-hidden-staff')
      if (saved) setHidden(new Set(JSON.parse(saved)))
    } catch {}
  }, [])
  useEffect(() => {
    try { localStorage.setItem('roster-hidden-staff', JSON.stringify([...hidden])) } catch {}
  }, [hidden])

  // Load the staff list once
  useEffect(() => {
    if (!ready) return
    supabase.from('profiles').select('id, full_name, job_title').eq('role', 'staff').order('full_name')
      .then(({ data }) => setStaff(data ?? []))
  }, [ready])

  // Load shifts, unavailability and approved leave for the selected day
  const loadDay = useCallback(async () => {
    if (!date) return
    const day = toYMD(date)
    const [{ data: s }, { data: u }, { data: l }] = await Promise.all([
      supabase.from('shifts').select('*').eq('date', day),
      supabase.from('unavailability').select('staff_id').eq('date', day),
      supabase.from('leave_requests').select('staff_id')
        .eq('status', 'approved').lte('start_date', day).gte('end_date', day),
    ])
    setShifts(s ?? [])
    setUnavailable(new Set([...(u ?? []), ...(l ?? [])].map(r => r.staff_id)))
  }, [date])

  useEffect(() => { if (ready) loadDay() }, [ready, loadDay])

  // Close the right-click menu when clicking anywhere else
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // Which staff get a column
  const columns = staff.filter(p =>
    !hidden.has(p.id) &&
    (!availableOnly || !unavailable.has(p.id))
  )

  // Works out which slots in a column are empty, the start of a shift block, or covered by a block
  function buildCells(staffId: string): Cell[] {
    const cells: Cell[] = SLOTS.map(t => ({ kind: 'empty', t }))
    shifts.filter(s => s.staff_id === staffId).forEach(shift => {
      const start = toMin(shift.start_time), end = toMin(shift.end_time)
      const covered = SLOTS.map((t, i) => ({ t, i })).filter(({ t }) => t >= start && t < end)
      if (!covered.length) return
      cells[covered[0].i] = { kind: 'block', t: covered[0].t, span: covered.length, shift }
      covered.slice(1).forEach(({ i }) => { cells[i] = { kind: 'skip' } })
    })
    return cells
  }
  const cellsByStaff = Object.fromEntries(columns.map(p => [p.id, buildCells(p.id)]))

  function toggleStaff(id: string) {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function openMenu(e: React.MouseEvent, staffId: string, t: number, shift?: Shift) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, staffId, t, shift })
  }

  async function saveShift() {
    if (!editing || !date) return
    if (editing.end <= editing.start) { alert('End time must be after start time'); return }
    const row = { staff_id: editing.staffId, date: toYMD(date), start_time: editing.start, end_time: editing.end }
    const { error } = editing.shiftId
      ? await supabase.from('shifts').update(row).eq('id', editing.shiftId)
      : await supabase.from('shifts').insert(row)
    if (error) { alert(error.message); return }
    setEditing(null)
    loadDay()
  }

  async function deleteShift(id: number) {
    if (!confirm('Delete this shift?')) return
    await supabase.from('shifts').delete().eq('id', id)
    loadDay()
  }

  async function setStatus(id: number, status: string) {
    await supabase.from('shifts').update({ status }).eq('id', id)
    loadDay()
  }

  function goToday() {
    const today = new Date()
    setDate(today)
    setMonth(today)
  }

  if (!ready || !date) return null
  
  const editingName = staff.find(p => p.id === editing?.staffId)?.full_name
  const isToday = toYMD(date) === toYMD(new Date())

  return (
    <AppWindow>
      <div className="flex gap-4 p-4">

        {/* ---------- Left column ---------- */}
        <aside className="w-64 shrink-0 space-y-3">
          {/* Month calendar */}
          <div className="rounded border border-gray-300 p-1">
            <DayPicker
              mode="single"
              selected={date}
              onSelect={d => d && setDate(d)}
              month={month}
              onMonthChange={setMonth}
              weekStartsOn={1}
              style={{
                '--rdp-day-width': '32px',
                '--rdp-day-height': '32px',
                '--rdp-day_button-width': '30px',
                '--rdp-day_button-height': '30px',
                '--rdp-accent-color': '#2563eb',
                fontSize: '13px',
              } as CSSProperties}
            />
          </div>

          {/* Staff tick list */}
          <div className="rounded border border-gray-300 p-3">
             <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Staff</h2>
              <div className="flex gap-2 text-xs">
                <button onClick={() => setHidden(new Set())} className="text-blue-600 hover:underline">All</button>
                <button onClick={() => setHidden(new Set(staff.map(p => p.id)))} className="text-blue-600 hover:underline">None</button>
              </div>
            </div>
            {staff.map(p => (
              <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={!hidden.has(p.id)} onChange={() => toggleStaff(p.id)} />
                <span className={unavailable.has(p.id) ? 'text-gray-400' : ''}>
                  {p.full_name}
                  {unavailable.has(p.id) && <span className="ml-1 text-xs text-red-500">(unavailable)</span>}
                </span>
              </label>
            ))}
          </div>

          {/* View options */}
          <div className="space-y-1 rounded border border-gray-300 p-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={availableOnly} onChange={e => setAvailableOnly(e.target.checked)} />
              Only available staff
            </label>
          </div>

          {/* Colour key */}
          <div className="space-y-1 px-1 text-xs text-gray-600">
            <div className="flex items-center gap-2"><span className="h-3 w-3 bg-slate-300" /> Rostered</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 bg-purple-200" /> AI suggested</div>
            <div className="flex items-center gap-2"><span className="h-3 w-3 bg-red-200" /> Needs cover</div>
          </div>  <RequestsPanel onChange={loadDay} />
        </aside>

        {/* ---------- Roster grid ---------- */}
        <section className="flex-1 overflow-x-auto rounded border border-gray-300">
          <div className="flex items-center justify-between border-b border-gray-300 px-3 py-2">
            <span className="font-semibold">
              {date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            {!isToday && (
              <button onClick={goToday} className="rounded border border-gray-400 px-2 py-0.5 text-xs hover:bg-gray-100">
                Today
              </button>
            )}
          </div>

          {columns.length === 0 && (
            <p className="border-b border-gray-300 px-3 py-2 text-sm text-gray-500">
              No staff selected. Tick people in the Staff list to show their columns.
            </p>
          )}
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-gray-400">
                  <th className="w-20 border-r border-gray-300 p-2 text-left font-medium">Time</th>
                  {columns.map(p => (
                    <th key={p.id} className="border-r border-gray-300 p-2 text-left font-medium">
                      <div>{p.full_name}</div>
                      <div className="text-xs font-normal text-gray-500">{p.job_title}</div>
                      {unavailable.has(p.id) && <div className="text-xs font-normal text-red-600">Unavailable</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SLOTS.map((t, row) => (
                  <tr key={t} className={t % 60 === 0 ? 'border-t border-gray-300' : ''}>
                    <td className="h-7 border-r border-gray-300 px-2 align-top text-xs text-gray-500">
                      {t % 60 === 0 ? fmt(t) : ''}
                    </td>
                    {columns.map(p => {
                      const cell = cellsByStaff[p.id][row]
                      if (cell.kind === 'skip') return null
                      if (cell.kind === 'block') {
                        const s = cell.shift
                        return (
                          <td
                            key={p.id}
                            rowSpan={cell.span}
                            onContextMenu={e => openMenu(e, p.id, cell.t, s)}
                            className={`cursor-context-menu border-r border-gray-300 px-2 py-1 align-top text-xs ${shiftColour(s)}`}
                          >
                            <div className="font-medium">{fmt(toMin(s.start_time))} – {fmt(toMin(s.end_time))}</div>
                            {s.ai_generated && <div>AI suggested</div>}
                            {s.status === 'needs_cover' && <div className="font-semibold text-red-700">Needs cover</div>}
                          </td>
                        )
                      }
                      return (
                        <td
                          key={p.id}
                          onContextMenu={e => openMenu(e, p.id, cell.t)}
                          className="cursor-context-menu border-r border-gray-300 hover:bg-blue-50"
                        />
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          <p className="border-t border-gray-300 px-3 py-1 text-xs text-gray-500">
            Right-click a time slot to add a shift, or right-click a shift to change it.
          </p>
        </section>
      </div>

      {/* ---------- Right-click menu ---------- */}
      {menu && (
        <div
          className="fixed z-50 w-48 rounded border border-gray-300 bg-white py-1 text-sm shadow-lg"
          style={{ top: menu.y, left: menu.x }}
          onClick={e => e.stopPropagation()}
        >
          {menu.shift ? (
            <>
              <button
                className="block w-full px-3 py-1.5 text-left hover:bg-gray-100"
                onClick={() => {
                  setEditing({
                    staffId: menu.staffId,
                    shiftId: menu.shift!.id,
                    start: menu.shift!.start_time.slice(0, 5),
                    end: menu.shift!.end_time.slice(0, 5),
                  })
                  setMenu(null)
                }}
              >Edit shift times</button>
              {menu.shift.status === 'needs_cover' ? (
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-gray-100"
                  onClick={() => { setStatus(menu.shift!.id, 'covered'); setMenu(null) }}
                >Mark as covered</button>
              ) : (
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-gray-100"
                  onClick={() => { setStatus(menu.shift!.id, 'needs_cover'); setMenu(null) }}
                >Mark as needs cover</button>
              )}
              <button
                className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                onClick={() => { deleteShift(menu.shift!.id); setMenu(null) }}
              >Delete shift</button>
            </>
          ) : (
            <button
              className="block w-full px-3 py-1.5 text-left hover:bg-gray-100"
              onClick={() => {
                setEditing({
                  staffId: menu.staffId,
                  start: toHHMM(menu.t),
                  end: toHHMM(Math.min(menu.t + 8 * 60, DAY_END)),
                })
                setMenu(null)
              }}
            >Add shift from {fmt(menu.t)}</button>
          )}
        </div>
      )}

      {/* ---------- Add / edit shift pop-up ---------- */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-80 space-y-3 rounded-md bg-white p-5 shadow-xl">
            <h3 className="font-semibold">{editing.shiftId ? 'Edit shift' : 'Add shift'}</h3>
            <p className="text-sm text-gray-600">
              {editingName} · {date.toLocaleDateString('en-AU')}
            </p>
            <label className="block text-sm">
              Start
              <input
                type="time" step={1800}
                value={editing.start}
                onChange={e => setEditing({ ...editing, start: e.target.value })}
                className="mt-1 w-full rounded border border-gray-300 p-1.5"
              />
            </label>
            <label className="block text-sm">
              End
              <input
                type="time" step={1800}
                value={editing.end}
                onChange={e => setEditing({ ...editing, end: e.target.value })}
                className="mt-1 w-full rounded border border-gray-300 p-1.5"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button onClick={saveShift} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </AppWindow>
  )
}