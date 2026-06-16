import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'

export default function MonoPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [monoAccountId, setMonoAccountId] = useState('')
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const res = await apiFetch(`/merchants/${merchantId}/mono`, {
      method: 'POST',
      body: JSON.stringify({ monoAccountId }),
    })

    setLoading(false)

    if (!res.ok) {
      const text = await res.text()
      setStatus('error')
      setMessage(text || 'Failed to link Mono account.')
      return
    }

    setStatus('success')
    setMessage('Bank account linked successfully.')
    setMonoAccountId('')
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

          {status === 'success' ? (
            <div style={{ textAlign: 'center', padding: '0.5rem 0 1rem' }}>
              <svg viewBox="0 0 24 24" style={{ width: 40, height: 40, fill: 'none', stroke: 'var(--emerald)', strokeWidth: 2, margin: '0 auto 0.75rem' }}>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <p style={{ fontWeight: 600, color: 'var(--ink)' }}>Bank account linked!</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', marginTop: 4 }}>Mesa can now auto-detect incoming payments.</p>
              <button className="btn-ghost" style={{ marginTop: '1rem', width: '100%' }} onClick={() => setStatus('idle')}>
                Link another account
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
              <label style={{ display: 'grid', gap: '6px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink)' }}>Mono Account ID</span>
                <input
                  className="form-input"
                  value={monoAccountId}
                  onChange={e => setMonoAccountId(e.target.value)}
                  placeholder="e.g. 5f1234abc..."
                  required
                />
              </label>
              <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', padding: '0.9rem' }}>
                {loading ? 'Linking…' : 'Link bank account'}
              </button>
              {status === 'error' && message && (
                <div className="alert-error">
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{message}</span>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </>
  )
}
