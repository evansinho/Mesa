import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ProspectSource, type Wrapped, type Prospect } from '../lib/api'

const SOURCES: { value: ProspectSource; label: string }[] = [
  { value: 'outbound', label: 'Outbound' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'referral', label: 'Referral' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'event', label: 'Event' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'organic', label: 'Organic' },
]

export default function NewProspectPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [businessName, setBusinessName] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState<ProspectSource>('outbound')
  const [sourceDetail, setSourceDetail] = useState('')
  const [instagramHandle, setInstagram] = useState('')
  const [contactName, setContactName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<Wrapped<Prospect>>('/staff/prospects', {
        businessName,
        phone,
        source,
        sourceDetail: sourceDetail || undefined,
        instagramHandle: instagramHandle || undefined,
        contactName: contactName || undefined,
      })
      await qc.invalidateQueries({ queryKey: ['prospects'] })
      navigate({ to: '/prospects/$id', params: { id: res.data.id } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <form onSubmit={submit}>
        <h2 style={{ fontSize: 19, marginBottom: 14 }}>New prospect</h2>

        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="business">Business name</label>
          <input
            id="business"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            autoCapitalize="words"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="phone">WhatsApp number</label>
          <input
            id="phone"
            inputMode="tel"
            placeholder="0803 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <div className="hint">
            This is what links them to their Mesa account when they sign up, so
            use the number you actually message.
          </div>
        </div>

        <div className="field">
          <label htmlFor="source">Where did they come from?</label>
          <select
            id="source"
            value={source}
            onChange={(e) => setSource(e.target.value as ProspectSource)}
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <div className="hint">Can’t be changed later — it’s how we tell which channels work.</div>
        </div>

        <div className="field">
          <label htmlFor="detail">Source detail <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <input
            id="detail"
            placeholder="campaign, partner, who referred them"
            value={sourceDetail}
            onChange={(e) => setSourceDetail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="contact">Contact name <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <input
            id="contact"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            autoCapitalize="words"
          />
        </div>

        <div className="field">
          <label htmlFor="ig">Instagram handle <span style={{ fontWeight: 400 }}>(optional)</span></label>
          <input
            id="ig"
            placeholder="@handle"
            autoCapitalize="none"
            value={instagramHandle}
            onChange={(e) => setInstagram(e.target.value)}
          />
        </div>

        <button className="btn wide" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save prospect'}
        </button>
      </form>
    </div>
  )
}
