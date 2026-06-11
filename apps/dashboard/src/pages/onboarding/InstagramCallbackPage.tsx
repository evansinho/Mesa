import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
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

export default function InstagramCallbackPage() {
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
      const res = await apiFetch('/instagram/embedded-signup', {
        method: 'POST',
        body: JSON.stringify({ code, merchantId, redirectUri: import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined }),
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
  }, [])

  return (
    <>
      <div className="page-header">
        <span className="section-label">Onboarding</span>
        <h1>Linking Instagram</h1>
      </div>
      <div style={{ maxWidth: 480 }}>
        <div className="card" style={{ padding: '1.75rem', textAlign: 'center' }}>
          {(status === 'idle' || status === 'loading') && (
            <>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                border: '3px solid var(--ghost)', borderTopColor: '#E1306C',
                margin: '0 auto 1.25rem',
                animation: 'spin 0.8s linear infinite',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              <p style={{ color: 'var(--smoke)' }}>Finalizing your Instagram connection…</p>
            </>
          )}
          {status === 'success' && (
            <>
              <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: '#E1306C', strokeWidth: 2, margin: '0 auto 1rem' }}>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '1.1rem' }}>{message}</p>
              <Link to="/settings" className="btn-ghost" style={{ marginTop: '1.25rem', display: 'inline-flex' }}>Back to channels</Link>
            </>
          )}
          {status === 'error' && (
            <>
              <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: 'var(--danger)', strokeWidth: 2, margin: '0 auto 1rem' }}>
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <p style={{ color: 'var(--danger)', fontWeight: 600 }}>{message}</p>
              <Link to="/settings" className="btn-ghost" style={{ marginTop: '1.25rem', display: 'inline-flex' }}>Try again</Link>
            </>
          )}
        </div>
      </div>
    </>
  )
}
