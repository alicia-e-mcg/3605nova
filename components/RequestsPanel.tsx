'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { callApi } from '@/lib/api'
import { fmtDate } from '@/lib/dates'

type Req = {
  id: number; start_date: string; end_date: string; type: string
  profiles: { full_name: string } | null
}

export default function RequestsPanel({ onChange }: { onChange: () => void }) {
  const [requests, setRequests] = useState<Req[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('leave_requests')
      .select('id, start_date, end_date, type, profiles(full_name)')
      .eq('status', 'pending')
      .order('start_date')
    setRequests((data ?? []) as unknown as Req[])
  }, [])

  // Load now, then check for new requests every 30 seconds
  useEffect(() => {
    load()
    const timer = setInterval(() => { load(); onChange() }, 30000)
    return () => clearInterval(timer)
  }, [load, onChange])

  async function decide(id: number, action: 'approve' | 'decline') {
    setBusyId(id)
    const res = await callApi('/api/leave/process', { leaveId: id, action })
    setBusyId(null)
    if (!res.ok) alert(res.error ?? 'Something went wrong')
    load()
    onChange()
  }

  return (
    <div className="rounded border border-gray-300 p-3">
      <h2 className="mb-2 text-sm font-semibold">Leave requests</h2>
      {requests.length === 0 ? (
        <p className="text-xs text-gray-500">No pending requests.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map(r => (
            <li key={r.id} className="text-sm">
              <div className="font-medium">{r.profiles?.full_name}</div>
              <div className="text-xs capitalize text-gray-600">
                {r.type} · {fmtDate(r.start_date)}{r.end_date !== r.start_date && ` – ${fmtDate(r.end_date)}`}
              </div>
              <div className="mt-1 flex gap-2">
                <button
                  disabled={busyId === r.id}
                  onClick={() => decide(r.id, 'approve')}
                  className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busyId === r.id ? 'Arranging cover…' : 'Approve'}
                </button>
                <button
                  disabled={busyId === r.id}
                  onClick={() => decide(r.id, 'decline')}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs disabled:opacity-50"
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}