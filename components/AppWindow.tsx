'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { House, CalendarDays, MessageSquare, Wallet, SlidersHorizontal, LogOut, type LucideIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export type ToolbarItem = {
  href?: string        // leave out to show a disabled (decorative) icon
  label: string        // shown as a tooltip on hover
  icon: LucideIcon
  highlight?: boolean
}

// The 4 icons shown inside the Staffing & Payroll module
export const MODULE_ICONS: ToolbarItem[] = [
  { href: '/home', label: 'Back to Bp Premier', icon: House },
  { href: '/dashboard', label: 'Roster', icon: CalendarDays },
  { href: '/chat', label: 'Chat room', icon: MessageSquare },
  { href: '/payroll', label: 'Payroll', icon: Wallet },
  { href: '/settings', label: 'Staffing needs', icon: SlidersHorizontal },
]

type Props = {
  title?: string
  icons?: ToolbarItem[]
  right?: ReactNode    // extra buttons on the right of the toolbar (e.g. the alerts bell)
  children: ReactNode
}

export default function AppWindow({ title = 'Bp Premier — Staffing & Payroll', icons = MODULE_ICONS, right, children }: Props) {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <div className="min-h-screen bg-gray-200 p-4 text-gray-900">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl flex-col overflow-hidden rounded-md border border-gray-400 bg-white shadow-lg">

        {/* Window title bar */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-1 text-xs text-gray-600">
          {title}
        </div>

        {/* Round icon toolbar */}
        <div className="flex items-center gap-3 border-b border-gray-300 bg-gray-50 px-3 py-2">
          {icons.map(({ href, label, icon: Icon, highlight }) => {
            const active = href === pathname
            const cls = `flex h-10 w-10 items-center justify-center rounded-full border transition
              ${active ? 'border-blue-700 bg-blue-600 text-white' : 'border-gray-400 bg-white text-gray-700 hover:bg-gray-100'}
              ${highlight ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`
            return href ? (
              <Link key={label} href={href} title={label} aria-label={label} className={cls}>
                <Icon size={18} />
              </Link>
            ) : (
              <span key={label} title={label} aria-label={label} className={`${cls} cursor-not-allowed opacity-40`}>
                <Icon size={18} />
              </span>
            )
          })}

          <div className="ml-auto flex items-center gap-3">
            {right}
            <button
              onClick={async () => { await supabase.auth.signOut(); router.push('/login') }}
              title="Log out"
              aria-label="Log out"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-400 bg-white text-gray-700 hover:bg-gray-100"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  )
}