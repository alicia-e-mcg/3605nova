'use client'
import AppWindow from '@/components/AppWindow'
import { useManager } from '@/lib/useManager'

export default function Chat() {
  const ready = useManager()
  if (!ready) return null
  return <AppWindow><p className="p-6 text-gray-500">Chat room coming next.</p></AppWindow>
}