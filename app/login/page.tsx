'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return setError(error.message)

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single()

    if (profile?.role === 'manager') router.push('/home')
    else router.push('/roster')
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-100">
      <form onSubmit={handleLogin} className="bg-white p-8 rounded-lg shadow w-80 space-y-4">
        <img src="/bp-logo.png" alt="Best Practice" className="mx-auto h-16" />
        <h1 className="text-center text-lg font-semibold text-gray-800">Staffing & Payroll</h1>
        <input
          className="w-full border rounded p-2 text-gray-900"
          type="email" placeholder="Email"
          value={email} onChange={e => setEmail(e.target.value)}
        />
        <input
          className="w-full border rounded p-2 text-gray-900"
          type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)}
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button className="w-full bg-blue-700 text-white rounded p-2 hover:bg-blue-800">
          Log in
        </button>
      </form>
    </main>
  )
}