'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/lib/useProfile'
import StaffWindow from '@/components/StaffWindow'
import { toYMD, fromYMD, fmtDate, sydneyToday } from '@/lib/dates'
import { callApi } from '@/lib/api'

type Leave = { id: number; start_date: string; end_date: string; type: string; status: string }

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  declined: 'bg-gray-200 text-gray-700',
}

export default function LeavePage() {
  const me = useProfile()
  const [requests, setRequests] = useState<Leave[]>([])
  const [type, setType] = useState('annual')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const load = useCallback(async () => {
    if (!me) return
    const { data } = await supabase
      .from('leave_requests')
      .select('id, start_date, end_date, type, status')
      .eq('staff_id', me.id)
      .order('start_date', { ascending: false })
    setRequests(data ?? [])
  }, [me])

  useEffect(() => { load() }, [load])

  async function reportSick(when: 'today' | 'tomorrow') {
    if (!me) return

    // Work out the date in Sydney time
    const today = sydneyToday()
    const tomorrowDate = fromYMD(today)
    tomorrowDate.setDate(tomorrowDate.getDate() + 1)
    const day = when === 'today' ? today : toYMD(tomorrowDate)

    // Don't allow two sick calls for the same day
    const alreadyReported = requests.some(r =>
      r.type === 'sick' && r.status !== 'declined' && r.start_date <= day && r.end_date >= day
    )
    if (alreadyReported) { alert(`You've already reported sick for ${fmtDate(day)}.`); return }

    if (!confirm(`Report sick for ${when} (${fmtDate(day)})? Your practice manager will be told and cover will be arranged.`)) return

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({ staff_id: me.id, start_date: day, end_date: day, type: 'sick' })
      .select('id')
      .single()
    if (error || !data) { alert(error?.message ?? 'Something went wrong'); return }

    const res = await callApi('/api/leave/process', { leaveId: data.id, action: 'sick' })
    if (!res.ok) alert(res.error ?? 'Your sick call was saved, but cover could not be arranged automatically.')
    else alert(`Thanks, get well soon. Your manager has been told and your shifts on ${fmtDate(day)} are being covered.`)
    load()
  }

  async function submitLeave(e: React.FormEvent) {
    e.preventDefault()
    if (!me) return
    if (!start || !end) { alert('Please choose a start and end date'); return }
    if (end < start) { alert('End date must be on or after the start date'); return }
    const { error } = await supabase
      .from('leave_requests')
      .insert({ staff_id: me.id, start_date: start, end_date: end, type })
    if (error) { alert(error.message); return }
    setStart('')
    setEnd('')
    load()
  }

    async function withdraw(r: Leave) {
    const message =
      r.status === 'approved'
        ? `Withdraw this ${r.type === 'sick' ? 'sick call' : 'leave'}? Your shifts will be given back to you and your manager will be told.`
        : 'Remove this request?'
    if (!confirm(message)) return

    const res = await callApi('/api/leave/withdraw', { leaveId: r.id })
    if (!res.ok) alert(res.error ?? 'Something went wrong')
    load()
  }

  if (!me) return null
  const today = toYMD(new Date())

  return (
    <StaffWindow>
      <div className="grid gap-6 p-4 md:grid-cols-[320px_1fr]">
        <section className="space-y-4">
          <h1 className="text-lg font-semibold">Leave &amp; sick</h1>

          {/* Report sick */}
          <div className="rounded border border-red-200 bg-red-50 p-3">
            <p className="mb-2 text-sm text-red-800">Can't make it in?</p>
            <div className="flex gap-2">
              <button
                onClick={() => reportSick('today')}
                className="flex-1 rounded bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Sick today
              </button>
              <button
                onClick={() => reportSick('tomorrow')}
                className="flex-1 rounded border border-red-600 bg-white py-2 text-sm font-medium text-red-700 hover:bg-red-100"
              >
                Sick tomorrow
              </button>
            </div>
          </div>

          {/* Request leave */}
          <form onSubmit={submitLeave} className="space-y-3 rounded border border-gray-300 p-3">
            <h2 className="text-sm font-semibold">Request leave</h2>
            <label className="block text-sm">
              Type
              <select value={type} onChange={e => setType(e.target.value)} className="mt-1 w-full rounded border border-gray-300 p-1.5">
                <option value="annual">Annual leave</option>
                <option value="personal">Personal leave</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="block text-sm">
              From
              <input type="date" min={today} value={start} onChange={e => setStart(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 p-1.5" />
            </label>
            <label className="block text-sm">
              To
              <input type="date" min={start || today} value={end} onChange={e => setEnd(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 p-1.5" />
            </label>
            <button className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Submit request
            </button>
          </form>
        </section>

        {/* My requests */}
        <section className="rounded border border-gray-300">
          <div className="border-b border-gray-300 px-3 py-2 font-semibold">My requests</div>
          {requests.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">No leave requests yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-300 text-left">
                  <th className="p-2 font-medium">Dates</th>
                  <th className="p-2 font-medium">Type</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} className="border-b border-gray-200">
                    <td className="p-2">
                      {fmtDate(r.start_date)}{r.end_date !== r.start_date && ` – ${fmtDate(r.end_date)}`}
                    </td>
                    <td className="p-2 capitalize">{r.type}</td>
                    <td className="p-2">
                      <span className={`rounded px-2 py-0.5 text-xs capitalize ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
                    </td>
                    <td className="p-2 text-right">
                      {(r.status !== 'approved' || r.end_date >= sydneyToday()) && (
                        <button onClick={() => withdraw(r)} className="text-xs text-gray-500 hover:text-red-600">
                          {r.status === 'approved' ? 'Withdraw' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </StaffWindow>
  )
}