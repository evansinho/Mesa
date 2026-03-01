import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'

type Status = 'idle' | 'loading' | 'success' | 'error'

function parseState(value: string | null): { merchantId?: string } {
  if (!value) return {}
  try {
    const decoded = JSON.parse(decodeURIComponent(value))
    return typeof decoded === 'object' && decoded !== null ? decoded : {}
  } catch {
    return {}
  }
}

export default function WhatsAppCallbackPage() {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code') ?? undefined
    const stateParam = params.get('state')
    const { merchantId } = parseState(stateParam)

    if (!code || !merchantId) {
      setStatus('error')
      setMessage('Missing code or merchantId in callback.')
      return
    }

    const run = async () => {
      setStatus('loading')
      const res = await apiFetch('/whatsapp/embedded-signup', {
        method: 'POST',
        body: JSON.stringify({
          code,
          merchantId,
          redirectUri: import.meta.env.VITE_META_REDIRECT_URI as string | undefined,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        setStatus('error')
        setMessage(text || 'Failed to link WhatsApp.')
        return
      }

      setStatus('success')
      setMessage('WhatsApp Business linked successfully.')
    }

    void run()
  }, [])

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
        maxWidth: 520,
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 24,
        padding: '2.5rem',
        textAlign: 'center',
        boxShadow: '0 20px 80px rgba(8, 12, 24, 0.55)',
      }}>
        <h1 style={{ fontSize: 28, marginBottom: '0.75rem' }}>Linking WhatsApp</h1>
        <p style={{ color: '#cbd5f5', lineHeight: 1.6 }}>
          {status === 'loading' && 'Finalizing your WhatsApp connection…'}
          {status === 'idle' && 'Preparing to link your WhatsApp account.'}
          {status === 'success' && message}
          {status === 'error' && message}
        </p>
      </section>
    </main>
  )
}
