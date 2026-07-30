import { useEffect, useRef, useState } from 'react'
import Connect from '@mono.co/connect.js'
import { apiFetch } from './api'

const MONO_PUBLIC_KEY = (import.meta.env.VITE_MONO_PUBLIC_KEY as string | undefined) ?? ''

// Shared by the onboarding page and Settings — both need to launch the same
// Mono Connect widget and exchange the resulting code the same way, so a
// merchant can link their bank account from either place rather than only
// during onboarding.
export function useMonoConnect(opts: {
  merchantId: string
  name?: string
  email?: string | null
  onConnected?: () => void
}) {
  const { merchantId, name, email, onConnected } = opts
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const connectRef = useRef<Connect | null>(null)
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected

  useEffect(() => {
    if (!MONO_PUBLIC_KEY || !merchantId || !name) return

    async function finish(code: string) {
      setStatus('connecting')
      setError(null)
      const res = await apiFetch(`/merchants/${merchantId}/mono`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      if (!res.ok) {
        const text = await res.text()
        setStatus('error')
        setError(text || 'Failed to link Mono account.')
        return
      }
      setStatus('idle')
      onConnectedRef.current?.()
    }

    connectRef.current = new Connect({
      key: MONO_PUBLIC_KEY,
      scope: 'auth',
      data: { customer: { name, email: email ?? undefined } },
      onClose: () => setStatus(s => (s === 'connecting' ? 'idle' : s)),
      onSuccess: ({ code }) => { void finish(code) },
    })
    connectRef.current.setup()
  }, [merchantId, name, email])

  function open() {
    if (!connectRef.current) return
    setError(null)
    setStatus('connecting')
    connectRef.current.open()
  }

  return { open, status, error, available: !!MONO_PUBLIC_KEY }
}
