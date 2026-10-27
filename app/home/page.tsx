'use client'
import { Users, CalendarCheck, Stethoscope, FileText, ClipboardList } from 'lucide-react'
import AppWindow, { type ToolbarItem } from '@/components/AppWindow'
import { useManager } from '@/lib/useManager'

// The first 4 icons stand in for normal Bp Premier features (not part of this prototype).
// The 5th opens our Staffing & Payroll module.
const BP_ICONS: ToolbarItem[] = [
  { label: 'Patients (Bp Premier)', icon: Users },
  { label: 'Appointment book (Bp Premier)', icon: CalendarCheck },
  { label: 'Clinical (Bp Premier)', icon: Stethoscope },
  { label: 'Reports (Bp Premier)', icon: FileText },
  { href: '/dashboard', label: 'Staffing & Payroll', icon: ClipboardList, highlight: true },
]

export default function Home() {
  const ready = useManager()
  if (!ready) return null

  return (
    <AppWindow title="Bp Premier" icons={BP_ICONS}>
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4">
        <img src="/bp-logo.png" alt="Best Practice" className="h-24" />
        <p className="text-sm text-gray-500">
          Open <span className="font-medium">Staffing &amp; Payroll</span> from the highlighted icon above.
        </p>
      </div>
    </AppWindow>
  )
}