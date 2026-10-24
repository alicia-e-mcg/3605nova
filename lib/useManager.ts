import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// Sends non-managers away. Returns true once the user is confirmed as a manager.
export function useManager() {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function check() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single()
      if (data?.role !== 'manager') { router.push('/roster'); return }

      setReady(true)
    }
    check()
  }, [router])

  return ready
}