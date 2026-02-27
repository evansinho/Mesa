import { useState } from 'react'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'

export default function MonoPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [monoAccountId, setMonoAccountId] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus(null)

    const res = await apiFetch(`/merchants/${merchantId}/mono`, {
      method: 'POST',
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
