'use client'
import { useEffect, useState, type CSSProperties } from 'react'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/lib/useProfile'
import StaffWindow from '@/components/StaffWindow'
import { toYMD, fromYMD, fmtTime, fmtDate } from '@/lib/dates'

type Shift = {
  id: number; staff_id: string; date: string
  start_time: string; end_time: string; status: string
}
type TeamShift = Shift & { profiles: { full_name: string; job_title: string | null } | null }

const calendarStyle = {
  '--rdp-day-width': '34px',
  '--rdp-day-height': '34px',
  '--rdp-day_button-width': '32px',
  '--rdp-day_button-height': '32px',
  '--rdp-accent-color': '#2563eb',
  fontSize: '13px',
} as CSSProperties

export default function MyRoster() {
  const me = useProfile()
  const [date, setDate] = useState<Date | null>(null)

  // Set today's date in the browser (not during the server pre-build)
  useEffect(() => { setDate(new Date()) }, [])
  const [myShifts, setMyShifts] = useState<Shift[]>([])
  const [myUnavailable, setMyUnavailable] = useState<string[]>([])
  const [team, setTeam] = useState<TeamShift[]>([])

  // My shifts and unavailable days
  useEffect(() => {
    if (!me) return
    async function load() {
      const [{ data: s }, { data: u }] = await Promise.all([
        supabase.from('shifts').select('*').eq('staff_id', me!.id).order('date').order('start_time'),
        supabase.from('unavailability').select('date').eq('staff_id', me!.id),
      ])
      setMyShifts(s ?? [])
      setMyUnavailable((u ?? []).map(r => r.date))
    }
    load()
  }, [me])

  // Everyone's shifts on the selected day (view only)
  useEffect(() => {
    if (!me || !date) return
    supabase
      .from('shifts')
      .select('*, profiles!shifts_staff_id_fkey(full_name, job_title)')      .eq('date', toYMD(date))
      .order('start_time')
      .then(({ data }) => setTeam((data ?? []) as TeamShift[]))
  }, [me, date])

    if (!me || !date) return null

  const today = toYMD(new Date())
  const upcoming = myShifts.filter(s => s.date >= today).slice(0, 5)

  return (
    <StaffWindow>
      <div className="grid gap-4 p-4 md:grid-cols-[280px_1fr]">

        {/* Left: calendar and my next shifts */}
        <aside className="space-y-3">
          <h1 className="text-lg font-semibold">Hi {me.full_name}</h1>

          <div className="rounded border border-gray-300 p-1">
            <DayPicker
              mode="single"
              selected={date}
              onSelect={d => d && setDate(d)}
              weekStartsOn={1}
              modifiers={{
                rostered: myShifts.map(s => fromYMD(s.date)),
                unavailable: myUnavailable.map(fromYMD),
              }}
              modifiersStyles={{
                rostered: { backgroundColor: '#cbd5e1', borderRadius: '9999px' },
                unavailable: { color: '#dc2626', textDecoration: 'line-through' },
              }}
              style={calendarStyle}
            />
          </div>

          <div className="space-y-1 px-1 text-xs text-gray-600">
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-slate-300" /> I'm rostered</div>
            <div className="flex items-center gap-2"><span className="font-semibold text-red-600 line-through">12</span> I'm unavailable</div>
          </div>

          <div className="rounded border border-gray-300 p-3">
            <h2 className="mb-2 text-sm font-semibold">My next shifts</h2>
            {upcoming.length === 0 ? (
              <p className="text-sm text-gray-500">No upcoming shifts.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {upcoming.map(s => (
                  <li key={s.id} className="flex justify-between">
                    <span>{fmtDate(s.date)}</span>
                    <span className="text-gray-600">{fmtTime(s.start_time)} – {fmtTime(s.end_time)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Right: team roster for the selected day */}
        <section className="rounded border border-gray-300">
          <div className="flex items-center justify-between border-b border-gray-300 px-3 py-2">
            <span className="font-semibold">
              Team roster — {date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">View only</span>
          </div>

          {team.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">Nobody is rostered on this day.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300 text-left">
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Role</th>
                  <th className="p-2 font-medium">Time</th>
                  <th className="p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {team.map(s => (
                  <tr key={s.id} className={`border-b border-gray-200 ${s.staff_id === me.id ? 'bg-blue-50 font-medium' : ''}`}>
                    <td className="p-2">{s.profiles?.full_name}{s.staff_id === me.id && ' (you)'}</td>
                    <td className="p-2 text-gray-600">{s.profiles?.job_title}</td>
                    <td className="p-2">{fmtTime(s.start_time)} – {fmtTime(s.end_time)}</td>
                    <td className="p-2">
                      {s.status === 'needs_cover'
                        ? <span className="text-red-600">Needs cover</span>
                        : <span className="text-gray-600">Rostered</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="border-t border-gray-300 px-3 py-2 text-xs text-gray-500">
            To change a shift, flag the day as unavailable, request leave, or contact your practice manager.
          </p>
        </section>
      </div>
    </StaffWindow>
  )
}