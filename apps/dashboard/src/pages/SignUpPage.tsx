import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import AuthLayout from '../components/AuthLayout'
import { setSession } from '../lib/auth'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

type Stage = 'form' | 'check-whatsapp'

export default function SignUpPage() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<Stage>('form')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const merchantRes = await fetch(`${API_URL}/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })

    if (!merchantRes.ok) {
      const text = await merchantRes.text()
      setError(text || 'Failed to create account.')
      setLoading(false)
      return
    }

    const authRes = await fetch(`${API_URL}/auth/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })

    if (!authRes.ok) {
      const text = await authRes.text()
      setError(text || 'Failed to send login code.')
      setLoading(false)
      return
    }

    await authRes.json()
    setLoading(false)
    setStage('check-whatsapp')
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setVerifying(true)

    const res = await fetch(`${API_URL}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code }),
    })

    setVerifying(false)

    if (!res.ok) {
      const text = await res.text()
      setError(text || 'Invalid or expired code.')
      return
    }

    const data = await res.json() as { sessionToken: string; merchantId: string }
    setSession({ token: data.sessionToken, merchantId: data.merchantId })
    void navigate({ to: '/onboarding/whatsapp' })
  }

  if (stage === 'check-whatsapp') {
    return (
      <AuthLayout>
        <div style={{ textAlign: 'center' }}>
          <svg viewBox="0 0 24 24" style={{ width: 52, height: 52, fill: 'none', stroke: 'var(--emerald)', strokeWidth: 1.5, margin: '0 auto 1rem' }}>
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          <span className="section-label">Account created</span>
          <h1 style={{ fontFamily: 'var(--font-head)', fontSize: '1.5rem', fontWeight: 700, margin: '0.75rem 0 0.5rem', color: 'var(--ink)' }}>
            Check your WhatsApp
          </h1>
          <p style={{ color: 'var(--smoke)', lineHeight: 1.65 }}>
            We sent a 6-digit code to <strong style={{ color: 'var(--ink)' }}>{phone}</strong>.
            Enter it below to finish setting up your account.
          </p>
          <form onSubmit={handleVerify} style={{ display: 'grid', gap: '1rem', marginTop: '1.25rem', textAlign: 'left' }}>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink)' }}>Verification code</span>
              <input
                className="form-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                required
              />
            </label>
            <button type="submit" className="btn-primary" disabled={verifying || code.length !== 6} style={{ width: '100%', padding: '0.9rem' }}>
              {verifying ? 'Verifying...' : 'Verify code'}
            </button>
          </form>
          {error && (
            <div className="alert-error" style={{ textAlign: 'left' }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}
          <button className="btn-ghost" style={{ marginTop: '1.5rem', width: '100%' }} onClick={() => setStage('form')}>
            Use a different number
          </button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <span className="section-label">Get started free</span>
      <h1 style={{ fontFamily: 'var(--font-head)', fontSize: '1.75rem', fontWeight: 700, margin: '0.75rem 0 0.4rem', color: 'var(--ink)' }}>
        Create your account
      </h1>
      <p style={{ color: 'var(--smoke)', lineHeight: 1.65, marginBottom: '1.75rem' }}>
        Enter your phone number and we'll send a login code to your WhatsApp.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
        <label style={{ display: 'grid', gap: '6px' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink)' }}>Phone number</span>
          <input
            className="form-input"
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+2348012345678"
            required
          />
        </label>
        <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: '0.25rem', width: '100%', padding: '0.9rem' }}>
          {loading ? 'Setting up…' : 'Get started'}
        </button>
      </form>

      {error && (
        <div className="alert-error">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {error}
        </div>
      )}

      <p style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.9rem', color: 'var(--smoke)' }}>
        Already have an account?{' '}
        <Link to="/login" style={{ color: 'var(--emerald)', fontWeight: 600 }}>Sign in</Link>
      </p>
    </AuthLayout>
  )
}
