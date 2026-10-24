import { supabase } from '@/lib/supabase'

// Calls one of our server routes, sending the logged-in user's token so the server knows who it is
export async function callApi(path: string, body: unknown): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token ?? ''}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ...data, ok: res.ok }
}