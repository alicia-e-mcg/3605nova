'use client'
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toYMD, fmtTime } from '@/lib/dates'
import { mergeShifts } from '@/lib/mergeShifts'

type Profile = { id: string; full_name: string; job_title: string | null }
type Shift = {
  id: number; staff_id: string; date: string
  start_time: string; end_time: string
  status: string; ai_generated: boolean
}

type Props = {
  date: Date                       // any day in the week to show
  staff?: Profile[]                // which people to show (defaults to all staff)
  highlightId?: string             // e.g. the logged-in staff member
  onOpenDay: (d: Date) => void     // clicking a day opens the day view
  onChangeDate: (d: Date) => void  // previous / next week
  refreshKey?: number              // change this to reload the week
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const hoursOf = (s: { start_time: string; end_time: string }) => (toMin(s.end_time) - toMin(s.start_time)) / 60

function mondayOf(d: Date) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
  return m
}
function addDays(d: Date, n: number) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function shiftColour(s: Shift) {
  if (s.status === 'needs_cover') return 'bg-red-200 border-l-4 border-red-500'
  if (s.ai_generated) return 'bg-purple-200 border-l-4 border-purple-500'
  return 'bg-slate-300 border-l-4 border-slate-500'
}

export default function WeekGrid({ date, staff, highlightId, onOpenDay, onChangeDate, refreshKey }: Props) {
  const weekStart = mondayOf(date)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const startYMD = toYMD(days[0])
  const endYMD = toYMD(days[6])

  const [allStaff, setAllStaff] = useState<Profile[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [off, setOff] = useState<Set<string>>(new Set()) // "staffId|YYYY-MM-DD" when unavailable or on leave

  // Load everyone if no staff list was passed in
  useEffect(() => {
    if (staff) return
    supabase.from('profiles').select('id, full_name, job_title').eq('role', 'staff').order('full_name')
      .then(({ data }) => setAllStaff(data ?? []))
  }, [staff])

  // Load the week's shifts, unavailable days and approved leave
  useEffect(() => {
    async function load() {
      const [{ data: s }, { data: u }, { data: l }] = await Promise.all([
        supabase.from('shifts').select('*').gte('date', startYMD).lte('date', endYMD),
        supabase.from('unavailability').select('staff_id, date').gte('date', startYMD).lte('date', endYMD),
        supabase.from('leave_requests').select('staff_id, start_date, end_date')
          .eq('status', 'approved').lte('start_date', endYMD).gte('end_date', startYMD),
      ])
      setShifts(s ?? [])

      const keys = new Set<string>()
      ;(u ?? []).forEach(r => keys.add(`${r.staff_id}|${r.date}`))
      const start = new Date(startYMD + 'T00:00:00')
      for (let i = 0; i < 7; i++) {
        const y = toYMD(addDays(start, i))
        ;(l ?? []).forEach(r => { if (y >= r.start_date && y <= r.end_date) keys.add(`${r.staff_id}|${y}`) })
      }
      setOff(keys)
    }
    load()
  }, [startYMD, endYMD, refreshKey])

  const people = staff ?? allStaff
  const merged = mergeShifts(shifts)
  const todayYMD = toYMD(new Date())

  return (
    <div>
      {/* Week navigation */}
      <div className="flex items-center justify-between border-b border-gray-300 px-3 py-2">
        <button
          onClick={() => onChangeDate(addDays(date, -7))}
          aria-label="Previous week"
          className="rounded border border-gray-300 p-1 hover:bg-gray-100"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-medium">
          {days[0].toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} –{' '}
          {days[6].toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <button
          onClick={() => onChangeDate(addDays(date, 7))}
          aria-label="Next week"
          className="rounded border border-gray-300 p-1 hover:bg-gray-100"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-400">
            <th className="w-36 border-r border-gray-300 p-2 text-left font-medium">Staff</th>
            {days.map(d => {
              const y = toYMD(d)
              return (
                <th key={y} className={`border-r border-gray-300 p-0 text-left font-medium ${y === todayYMD ? 'bg-blue-50' : ''}`}>
                  <button onClick={() => onOpenDay(d)} title="Open this day" className="w-full p-2 text-left hover:bg-gray-100">
                    <div>{d.toLocaleDateString('en-AU', { weekday: 'short' })}</div>
                    <div className="font-normal text-gray-500">{d.getDate()}/{d.getMonth() + 1}</div>
                  </button>
                </th>
              )
            })}
            <th className="w-16 p-2 text-right font-medium">Hours</th>
          </tr>
        </thead>
        <tbody>
          {people.map(p => {
            const mine = merged.filter(s => s.staff_id === p.id)
            const total = mine.reduce((sum, s) => sum + hoursOf(s), 0)
            const isMe = p.id === highlightId
            return (
              <tr key={p.id} className={`border-b border-gray-200 ${isMe ? 'bg-blue-50' : ''}`}>
                <td className="border-r border-gray-300 p-2 align-top">
                  <div className="text-sm font-medium">{p.full_name}{isMe && ' (you)'}</div>
                  <div className="text-gray-500">{p.job_title}</div>
                </td>
                {days.map(d => {
                  const y = toYMD(d)
                  const dayShifts = mine.filter(s => s.date === y)
                  const isOff = off.has(`${p.id}|${y}`)
                  return (
                    <td
                      key={y}
                      onClick={() => onOpenDay(d)}
                      className="cursor-pointer border-r border-gray-300 p-1 align-top hover:bg-gray-50"
                    >
                      {dayShifts.map(s => (
                        <div key={s.id} className={`mb-1 rounded px-1.5 py-1 ${shiftColour(s)}`}>
                          {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
                          {s.status === 'needs_cover' && <div className="font-semibold text-red-700">Needs cover</div>}
                          {s.ai_generated && s.status !== 'needs_cover' && <div>AI suggested</div>}
                        </div>
                      ))}
                      {isOff && dayShifts.length === 0 && <div className="text-red-500">Unavailable</div>}
                    </td>
                  )
                })}
                <td className="p-2 text-right align-top font-medium">
                  {total ? `${+total.toFixed(1)}h` : '–'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {people.length === 0 && <p className="p-3 text-sm text-gray-500">No staff to show.</p>}
      <p className="border-t border-gray-300 px-3 py-1 text-xs text-gray-500">Click a day to open it.</p>
    </div>
  )
}