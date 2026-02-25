'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function WhatsAppSignupPage() {
  const [phone, setPhone] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus(null)

    const res = await fetch('/api/merchants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })

    if (!res.ok) {
      const text = await res.text()
      setStatus(text || 'Failed to create merchant.')
      return
    }

    const data = await res.json() as { merchant?: { id: string } }
    if (!data.merchant?.id) {
      setStatus('No merchant id returned.')
      return
    }

    router.push(`/onboarding/whatsapp?merchantId=${data.merchant.id}`)
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
          We’ll use this to set up your WhatsApp Business connection.
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
            style={{
              marginTop: '0.5rem',
              padding: '0.9rem 1.5rem',
              borderRadius: 999,
              background: 'linear-gradient(120deg, #22c55e, #16a34a)',
              color: '#04110a',
              fontWeight: 700,
              letterSpacing: '0.02em',
              border: 'none',
            }}
          >
            Continue to WhatsApp
          </button>
        </form>

        {status && <p style={{ marginTop: '1rem', color: '#fca5a5' }}>{status}</p>}
      </section>
    </main>
  )
}
