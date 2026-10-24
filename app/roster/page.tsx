'use client'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function Roster() {
  const router = useRouter()
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">My roster (view only)</h1>
      <p>Roster and unavailability calendar coming soon.</p>
      <button
        onClick={async () => { await supabase.auth.signOut(); router.push('/login') }}
        className="border rounded px-3 py-1 mt-4"
      >Log out</button>
    </main>
  )
}