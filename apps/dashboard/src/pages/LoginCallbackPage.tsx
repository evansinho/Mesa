import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { setSession } from '../lib/auth'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

export default function LoginCallbackPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('Verifying link...')

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) {
      setStatus('Missing token.')
      return
    }

    const run = async () => {
      const res = await fetch(`${API_URL}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const text = await res.text()
        setStatus(text || 'Failed to verify link')
        return
      }
      const data = await res.json() as { sessionToken: string; merchantId: string }
      setSession({ token: data.sessionToken, merchantId: data.merchantId })
      setStatus('Logged in. Redirecting...')
      void navigate({ to: '/orders' })
    }

    void run()
  }, [navigate])

  return (
    <main style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0b0f1f 0%, #101828 45%, #182230 100%)',
      color: '#e6edf7',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    }}>
      <section style={{
        width: '100%',
        maxWidth: 420,
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 24,
        padding: '2rem',
        textAlign: 'center',
      }}>
        <h1 style={{ fontSize: 24, marginBottom: '0.5rem' }}>Signing you in</h1>
        <p style={{ color: '#cbd5f5' }}>{status}</p>
      </section>
    </main>
  )
}
