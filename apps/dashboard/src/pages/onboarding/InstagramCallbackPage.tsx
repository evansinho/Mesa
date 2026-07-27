import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { apiFetch } from '../../lib/api'

type Status = 'idle' | 'loading' | 'success' | 'needs_verification' | 'error'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

function parseState(value: string | null): { merchantId?: string; platform?: boolean; token?: string } {
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
  const [verificationUrl, setVerificationUrl] = useState<string | undefined>(undefined)
  const [verificationUsername, setVerificationUsername] = useState<string | undefined>(undefined)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code') ?? undefined
    const stateParam = params.get('state')
    const { merchantId, platform, token } = parseState(stateParam)

    if (!code || (!merchantId && !platform)) {
      setStatus('error')
      setMessage('Missing code or merchantId in callback.')
      return
    }

    const run = async () => {
      setStatus('loading')

      // Mesa's own platform-wide Instagram account (mirrors the shared
      // WhatsApp number) — a one-time bootstrap action, not tied to any
      // merchant session, so this hits a capability-token-guarded route
      // directly rather than going through apiFetch.
      if (platform) {
        const res = await fetch(`${API_URL}/instagram/connect-platform-account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, token, redirectUri: import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined }),
        })
        if (!res.ok) {
          const text = await res.text()
          setStatus('error')
          setMessage(text || 'Failed to connect Mesa’s Instagram account.')
          return
        }
        const body = await res.json() as { username?: string }
        setStatus('success')
        setMessage(body.username ? `Mesa’s Instagram account connected: @${body.username}` : 'Mesa’s Instagram account connected.')
        return
      }

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
      const body = await res.json() as { verificationUrl?: string; verificationUsername?: string }
      if (body.verificationUrl) {
        setStatus('needs_verification')
        setVerificationUrl(body.verificationUrl)
        setVerificationUsername(body.verificationUsername)
      } else {
        setStatus('success')
        setMessage('Instagram connected successfully.')
      }
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
              <Link to="/settings" className="btn btn-lg btn-ghost" style={{ marginTop: '1.25rem' }}>Back to channels</Link>
            </>
          )}
          {status === 'needs_verification' && (
            <>
              <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: '#E1306C', strokeWidth: 2, margin: '0 auto 1rem' }}>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '1.1rem' }}>Instagram connected — one more step.</p>
              <p style={{ color: 'var(--smoke)', marginTop: '0.5rem' }}>
                Instagram only lets Mesa message you once you've messaged it first. Tap below to send a one-time activation DM to{' '}
                {verificationUsername ? <strong>@{verificationUsername}</strong> : 'Mesa'} — after that, Mesa can notify you on Instagram about new orders and payments.
              </p>
              <a
                href={verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-lg btn-primary"
                style={{ marginTop: '1.25rem', textDecoration: 'none' }}
              >
                Send activation DM
              </a>
              <div>
                <Link to="/settings" className="btn btn-lg btn-ghost" style={{ marginTop: '0.75rem' }}>Back to channels</Link>
              </div>
            </>
          )}
          {status === 'error' && (
            <>
              <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: 'var(--danger)', strokeWidth: 2, margin: '0 auto 1rem' }}>
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <p style={{ color: 'var(--danger)', fontWeight: 600 }}>{message}</p>
              <Link to="/settings" className="btn btn-lg btn-ghost" style={{ marginTop: '1.25rem' }}>Try again</Link>
            </>
          )}
        </div>
      </div>
    </>
  )
}
