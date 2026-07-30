import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle } from 'lucide-react'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'
import { useMonoConnect } from '../../lib/useMonoConnect'

type Merchant = {
  name: string
  email: string | null
  config: { monoAccountId?: string } | null
}

export default function MonoPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const navigate = useNavigate()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [connected, setConnected] = useState(false)
  const [email, setEmail] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)

  useEffect(() => {
    if (!merchantId) return
    let cancelled = false
    ;(async () => {
      const res = await apiFetch(`/merchants/${merchantId}`)
      if (cancelled) return
      if (!res.ok) { setLoadError(true); setLoading(false); return }
      const { merchant: m } = await res.json() as { merchant: Merchant }
      if (cancelled) return
      setMerchant(m)
      setConnected(!!m.config?.monoAccountId)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [merchantId])

  const mono = useMonoConnect({
    merchantId,
    name: merchant?.name,
    email: merchant?.email,
    onConnected: () => setConnected(true),
  })

  function skip() {
    void navigate({ to: '/' })
  }

  async function saveEmail(e: React.FormEvent) {
    e.preventDefault()
    setEmailSaving(true)
    setEmailError(null)
    const res = await apiFetch(`/merchants/${merchantId}/billing-email`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    setEmailSaving(false)
    if (!res.ok) {
      setEmailError(await res.text() || 'Failed to save email.')
      return
    }
    setMerchant(m => m ? { ...m, email: email.trim().toLowerCase() } : m)
  }

  return (
    <>
      <div className="page-header">
        <span className="section-label">Onboarding</span>
        <h1>Connect Bank via Mono</h1>
        <p style={{ color: 'var(--smoke)', marginTop: 8, lineHeight: 1.65 }}>
          Link your bank account so Mesa can automatically detect payments and reconcile orders.
        </p>
      </div>

      <div style={{ maxWidth: 480 }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(15, 76, 53, 0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, fill: 'none', stroke: 'var(--emerald)', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                <rect x="2" y="5" width="20" height="14" rx="2"/>
                <line x1="2" y1="10" x2="22" y2="10"/>
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '0.9375rem' }}>Mono Bank Link</p>
              <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Connect your Nigerian bank account</p>
            </div>
          </div>

          {connected ? (
            <div style={{ textAlign: 'center', padding: '0.5rem 0 1rem' }}>
              <svg viewBox="0 0 24 24" style={{ width: 40, height: 40, fill: 'none', stroke: 'var(--emerald)', strokeWidth: 2, margin: '0 auto 0.75rem' }}>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <p style={{ fontWeight: 600, color: 'var(--ink)' }}>Bank account linked!</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', marginTop: 4 }}>Mesa can now auto-detect incoming payments.</p>
            </div>
          ) : loadError ? (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>Could not load your account. Refresh and try again.</span>
            </div>
          ) : !mono.available ? (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>Bank auto-confirmation isn't set up yet. Check back soon.</span>
            </div>
          ) : !loading && merchant && !merchant.email ? (
            <form onSubmit={saveEmail} style={{ display: 'grid', gap: '1rem' }}>
              <label style={{ display: 'grid', gap: '6px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink)' }}>Billing email</span>
                <span style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Mono requires an email to link your account.</span>
                <input
                  className="form-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@business.com"
                  required
                />
              </label>
              <button type="submit" className="btn-primary" disabled={emailSaving} style={{ width: '100%', padding: '0.9rem' }}>
                {emailSaving ? 'Saving…' : 'Continue'}
              </button>
              {emailError && (
                <div className="alert-error">
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{emailError}</span>
                </div>
              )}
            </form>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={loading || mono.status === 'connecting'}
                style={{ width: '100%', padding: '0.9rem' }}
                onClick={mono.open}
              >
                {mono.status === 'connecting' ? 'Connecting…' : loading ? 'Loading…' : 'Connect via Mono'}
              </button>
              {mono.status === 'error' && mono.error && (
                <div className="alert-error">
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{mono.error}</span>
                </div>
              )}
            </div>
          )}

          {!connected && (
            <button type="button" className="btn-ghost" style={{ width: '100%', marginTop: '1rem' }} onClick={skip}>
              Skip for now
            </button>
          )}
        </div>
      </div>
    </>
  )
}
