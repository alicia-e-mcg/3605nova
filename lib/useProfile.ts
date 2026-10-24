import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export type Me = { id: string; full_name: string; role: string; job_title: string | null }

// Returns the logged-in user's profile, or sends them to login
export function useProfile() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, role, job_title')
        .eq('id', user.id)
        .single()
      if (!data) { router.push('/login'); return }

      setMe(data)
    }
    load()
  }, [router])

  return me
}