'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { callApi } from '@/lib/api'
import { fmtDate } from '@/lib/dates'

type Req = {
  id: number; start_date: string; end_date: string; type: string
  profiles: { full_name: string } | null
}
type Alert = { id: number; body: string; created_at: string }

export default function RequestsPanel({ onChange }: { onChange: () => void }) {
  const [requests, setRequests] = useState<Req[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const [{ data: r }, { data: a }] = await Promise.all([
      supabase.from('leave_requests')
        .select('id, start_date, end_date, type, profiles(full_name)')
        .eq('status', 'pending')
        .order('start_date'),
      supabase.from('messages')
        .select('id, body, created_at')
        .eq('from_ai', true)
        .eq('recipient_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5),
    ])
    setRequests((r ?? []) as unknown as Req[])
    setAlerts(a ?? [])
  }, [])

  // Load now, then check for new requests and alerts every 30 seconds
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
    <>
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

      <div className="rounded border border-purple-200 bg-purple-50 p-3">
        <h2 className="mb-2 text-sm font-semibold text-purple-900">AI alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-xs text-purple-700">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {alerts.map(a => (
              <li key={a.id} className="text-xs text-purple-900">
                <div className="text-[10px] text-purple-600">
                  {new Date(a.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </div>
                {a.body}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}