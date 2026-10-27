'use client'
import type { ReactNode } from 'react'
import { CalendarDays, CalendarX, Plane, Wallet } from 'lucide-react'
import AppWindow, { type ToolbarItem } from '@/components/AppWindow'

const STAFF_ICONS: ToolbarItem[] = [
  { href: '/roster', label: 'My roster', icon: CalendarDays },
  { href: '/availability', label: 'Unavailable days', icon: CalendarX },
  { href: '/leave', label: 'Leave & sick', icon: Plane },
  { href: '/my-pay', label: 'My pay', icon: Wallet },
]

export default function StaffWindow({ children }: { children: ReactNode }) {
  return (
    <AppWindow title="Bp Premier — My Roster" icons={STAFF_ICONS}>
      {children}
    </AppWindow>
  )
}