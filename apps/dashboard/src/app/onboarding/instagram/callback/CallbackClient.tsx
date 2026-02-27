'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

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

export default function CallbackClient() {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')

  const searchParams = useSearchParams()
  const code = searchParams.get('code') ?? undefined
  const stateParam = searchParams.get('state')

  const { merchantId } = useMemo(() => parseState(stateParam), [stateParam])

  useEffect(() => {
    if (!code || !merchantId) {
      setStatus('error')
      setMessage('Missing code or merchantId in callback.')
      return
    }

    const run = async () => {
      setStatus('loading')
      const res = await fetch('/api/instagram/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          merchantId,
          redirectUri: process.env.NEXT_PUBLIC_META_INSTAGRAM_REDIRECT_URI,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        setStatus('error')
        setMessage(text || 'Failed to link Instagram.')
        return
      }

      setStatus('success')
      setMessage('Instagram connected successfully.')
    }

    void run()
  }, [code, merchantId])

  return (
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
      <h1 style={{ fontSize: 28, marginBottom: '0.75rem' }}>Linking Instagram</h1>
      <p style={{ color: '#cbd5f5', lineHeight: 1.6 }}>
        {status === 'loading' && 'Finalizing your Instagram connection…'}
        {status === 'idle' && 'Preparing to link your Instagram account.'}
        {status === 'success' && message}
        {status === 'error' && message}
      </p>
    </section>
  )
}
