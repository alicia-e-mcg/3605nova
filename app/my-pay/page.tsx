'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/lib/useProfile'
import StaffWindow from '@/components/StaffWindow'
import { fmtDate } from '@/lib/dates'

type Rates = { saturday: number; sunday: number; holiday: number; overtime: number }
type Payslip = {
  id: number
  week_start: string | null
  week_end: string | null
  base_rate: number
  ordinary_hours: number
  saturday_hours: number
  sunday_hours: number
  holiday_hours: number
  overtime_hours: number
  gross_pay: number
  rates: Rates | null
}

const LINES: { key: keyof Payslip; label: string; rateKey: keyof Rates | null }[] = [
  { key: 'ordinary_hours', label: 'Ordinary (Mon–Fri)', rateKey: null },
  { key: 'saturday_hours', label: 'Saturday', rateKey: 'saturday' },
  { key: 'sunday_hours', label: 'Sunday', rateKey: 'sunday' },
  { key: 'holiday_hours', label: 'Public holiday', rateKey: 'holiday' },
  { key: 'overtime_hours', label: 'Overtime', rateKey: 'overtime' },
]

const num = (v: unknown) => Number(v) || 0
const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })
const weekLabel = (p: Payslip) =>
  p.week_start && p.week_end ? `${fmtDate(p.week_start)} – ${fmtDate(p.week_end)}` : 'Pay week'

export default function MyPay() {
  const me = useProfile()
  const [slips, setSlips] = useState<Payslip[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!me) return
    supabase
      .from('payroll_items')
      .select('id, week_start, week_end, base_rate, ordinary_hours, saturday_hours, sunday_hours, holiday_hours, overtime_hours, gross_pay, rates')
      .eq('staff_id', me.id)
      .order('week_start', { ascending: false })
      .then(({ data }) => {
        const list = (data ?? []) as Payslip[]
        setSlips(list)
        if (list.length) setSelectedId(list[0].id)
        setLoaded(true)
      })
  }, [me])

  if (!me) return null

  const slip = slips.find(s => s.id === selectedId)

  return (
    <StaffWindow>
      <div className="space-y-4 p-4">
        <h1 className="text-lg font-semibold">My pay</h1>

        {loaded && slips.length === 0 ? (
          <p className="rounded border border-gray-300 p-6 text-sm text-gray-600">
            No pay to show yet. Your payslip appears here once your practice manager has confirmed that week&apos;s payroll.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            {/* Left: list of pay weeks */}
            <aside className="rounded border border-gray-300">
              <ul>
                {slips.map(s => (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelectedId(s.id)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-100 ${s.id === selectedId ? 'bg-blue-100 font-medium' : ''}`}
                    >
                      <span>{weekLabel(s)}</span>
                      <span className="text-gray-600">{money(num(s.gross_pay))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            {/* Right: the payslip */}
            {slip && (
              <section className="rounded border border-gray-300 p-4 text-sm">
                <h2 className="text-base font-semibold">Payslip</h2>
                <p className="mb-3 text-gray-600">
                  {me.full_name} · Week of {weekLabel(slip)} · Base rate {money(num(slip.base_rate))}/h
                </p>

                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                      <th className="pb-1 font-medium">Type</th>
                      <th className="pb-1 text-right font-medium">Hours</th>
                      <th className="pb-1 text-right font-medium">Rate</th>
                      <th className="pb-1 text-right font-medium">Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LINES.filter(l => num(slip[l.key]) > 0).map(l => {
                      const mult = l.rateKey ? num(slip.rates?.[l.rateKey] ?? 1) : 1
                      const rate = round2(num(slip.base_rate) * mult)
                      return (
                        <tr key={l.key} className="border-b border-gray-100">
                          <td className="py-1.5">{l.label}</td>
                          <td className="py-1.5 text-right">{num(slip[l.key])}h</td>
                          <td className="py-1.5 text-right text-gray-600">{money(rate)}/h</td>
                          <td className="py-1.5 text-right">{money(round2(num(slip[l.key]) * rate))}</td>
                        </tr>
                      )
                    })}
                    <tr className="font-semibold">
                      <td className="pt-2">Gross pay</td>
                      <td className="pt-2 text-right">
                        {round2(LINES.reduce((s, l) => s + num(slip[l.key]), 0))}h
                      </td>
                      <td />
                      <td className="pt-2 text-right">{money(num(slip.gross_pay))}</td>
                    </tr>
                  </tbody>
                </table>

                <p className="mt-4 text-xs text-gray-500">
                  Gross pay before tax and super. If something looks wrong, contact your practice manager.
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </StaffWindow>
  )
}