import { useState } from 'react'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

type Stage = 'form' | 'check-whatsapp'

export default function SignUpPage() {
  const [phone, setPhone] = useState('')
  const [stage, setStage] = useState<Stage>('form')
  const [devLink, setDevLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    // 1. Create (or retrieve) the merchant
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

    // 2. Send magic link to their WhatsApp
    const authRes = await fetch(`${API_URL}/auth/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })

    if (!authRes.ok) {
      const text = await authRes.text()
      setError(text || 'Failed to send login link.')
      setLoading(false)
      return
    }

    const authData = await authRes.json() as { link?: string }
    if (authData.link) setDevLink(authData.link)

    setLoading(false)
    setStage('check-whatsapp')
  }

  if (stage === 'check-whatsapp') {
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
          boxShadow: '0 20px 80px rgba(8, 12, 24, 0.55)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: '1rem' }}>💬</div>
          <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
            Mesa · Signup
          </p>
          <h1 style={{ fontSize: 28, margin: '0.75rem 0 0.5rem' }}>Check your WhatsApp</h1>
          <p style={{ color: '#cbd5f5', lineHeight: 1.6 }}>
            We sent a login link to <strong style={{ color: '#e2e8f0' }}>{phone}</strong>.
            Tap it to continue setting up your account.
          </p>
          {devLink && (
            <p style={{ marginTop: '1.5rem', fontSize: 13, color: '#94a3b8' }}>
              Dev link:{' '}
              <a href={devLink} style={{ color: '#7dd3fc', wordBreak: 'break-all' }}>{devLink}</a>
            </p>
          )}
        </section>
      </main>
    )
  }

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
        maxWidth: 560,
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 24,
        padding: '2.5rem',
        boxShadow: '0 20px 80px rgba(8, 12, 24, 0.55)',
      }}>
        <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
          Mesa · Signup
        </p>
        <h1 style={{ fontSize: 32, margin: '0.75rem 0 0.5rem' }}>Start with your phone number</h1>
        <p style={{ color: '#cbd5f5', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          We'll send a login link to your WhatsApp to get you started.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
          <label style={{ display: 'grid', gap: '0.5rem' }}>
            <span style={{ fontSize: 14, color: '#94a3b8' }}>Phone number</span>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+2348012345678"
              required
              style={{
                padding: '0.85rem 1rem',
                borderRadius: 12,
                border: '1px solid rgba(148, 163, 184, 0.3)',
                background: '#0b1220',
                color: '#e2e8f0',
                fontSize: 16,
              }}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: '0.5rem',
              padding: '0.9rem 1.5rem',
              borderRadius: 999,
              background: 'linear-gradient(120deg, #22c55e, #16a34a)',
              color: '#04110a',
              fontWeight: 700,
              letterSpacing: '0.02em',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Setting up…' : 'Get started'}
          </button>
        </form>

        {error && <p style={{ marginTop: '1rem', color: '#fca5a5' }}>{error}</p>}
      </section>
    </main>
  )
}
