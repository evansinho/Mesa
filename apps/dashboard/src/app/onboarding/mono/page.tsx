'use client'

import { useState } from 'react'

export default function MonoOnboardingPage() {
  const [merchantId, setMerchantId] = useState('')
  const [monoAccountId, setMonoAccountId] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus(null)

    const res = await fetch(`/api/merchants/${merchantId}/mono`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mesa-api-key': '' },
      body: JSON.stringify({ monoAccountId }),
    })

    if (!res.ok) {
      const text = await res.text()
      setStatus(`Failed: ${text}`)
      return
    }

    setStatus('Mono account linked')
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 640 }}>
      <h1>Connect Bank via Mono</h1>
      <p>Placeholder flow: enter a Mono account ID to link a merchant.</p>

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
        <label>
          Merchant ID
          <input
            value={merchantId}
            onChange={e => setMerchantId(e.target.value)}
            style={{ width: '100%', padding: '0.5rem' }}
          />
        </label>
        <label>
          Mono Account ID
          <input
            value={monoAccountId}
            onChange={e => setMonoAccountId(e.target.value)}
            style={{ width: '100%', padding: '0.5rem' }}
          />
        </label>
        <button type="submit">Link Account</button>
      </form>

      {status && <p>{status}</p>}
    </main>
  )
}
