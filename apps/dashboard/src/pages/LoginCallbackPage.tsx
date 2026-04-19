import { useEffect, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { setSession } from '../lib/auth'
import AuthLayout from '../components/AuthLayout'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

export default function LoginCallbackPage() {
  const navigate = useNavigate()
  const { token } = useSearch({ from: '/login/callback' })
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [message, setMessage] = useState('Verifying your link…')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('Invalid link — no token found.')
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
        setStatus('error')
        setMessage(text || 'Failed to verify link. It may have expired.')
        return
      }
      const data = await res.json() as { sessionToken: string; merchantId: string }
      setSession({ token: data.sessionToken, merchantId: data.merchantId })
      setStatus('success')
      setMessage('Signed in successfully. Redirecting…')

      const profileRes = await fetch(`${API_URL}/merchants/${data.merchantId}`, {
        headers: { Authorization: `Bearer ${data.sessionToken}` },
      })
      const profileData = profileRes.ok ? await profileRes.json() as { merchant: { channels: { channel: string }[] } } : null
      const hasWhatsApp = profileData?.merchant.channels.some(c => c.channel === 'whatsapp') ?? false

      void navigate({ to: hasWhatsApp ? '/orders' : '/onboarding/whatsapp' })
    }

    void run()
  }, [navigate, token])

  return (
    <AuthLayout>
      <div style={{ textAlign: 'center', padding: '1rem 0' }}>
        {status === 'verifying' && (
          <>
            {/* Spinner */}
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              border: '3px solid var(--ghost)', borderTopColor: 'var(--emerald)',
              margin: '0 auto 1.5rem',
              animation: 'spin 0.8s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </>
        )}
        {status === 'success' && (
          <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: 'var(--emerald)', strokeWidth: 2, margin: '0 auto 1.5rem' }}>
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
        {status === 'error' && (
          <svg viewBox="0 0 24 24" style={{ width: 48, height: 48, fill: 'none', stroke: 'var(--danger)', strokeWidth: 2, margin: '0 auto 1.5rem' }}>
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        )}

        <h1 style={{ fontFamily: 'var(--font-head)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--ink)', marginBottom: '0.5rem' }}>
          {status === 'verifying' ? 'Signing you in' : status === 'success' ? 'All done!' : 'Something went wrong'}
        </h1>
        {status === 'error' ? (
          <div className="alert-error" style={{ textAlign: 'left', marginTop: 0 }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {message}
          </div>
        ) : (
          <p style={{ color: 'var(--smoke)', lineHeight: 1.65 }}>{message}</p>
        )}

        {status === 'error' && (
          <a href="/login" className="btn-primary" style={{ marginTop: '1.5rem', display: 'inline-flex' }}>
            Back to sign in
          </a>
        )}
      </div>
    </AuthLayout>
  )
}
