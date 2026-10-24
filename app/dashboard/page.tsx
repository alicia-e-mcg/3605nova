'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function Dashboard() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [staff, setStaff] = useState<any[]>([])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return router.push('/login')

      const { data: me } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (me?.role !== 'manager') return router.push('/roster')
      setName(me.full_name)

      const { data: all } = await supabase.from('profiles').select('*')
      setStaff(all ?? [])
    }
    load()
  }, [router])

  async function logout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <main className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Welcome, {name}</h1>
        <button onClick={logout} className="border rounded px-3 py-1">Log out</button>
      </div>
      <h2 className="font-semibold mb-2">Staff</h2>
      <ul className="space-y-1">
        {staff.map(s => (
          <li key={s.id}>{s.full_name} — {s.job_title} ({s.role})</li>
        ))}
      </ul>
    </main>
  )
}