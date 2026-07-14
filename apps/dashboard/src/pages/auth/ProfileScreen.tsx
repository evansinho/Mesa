import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { Btn } from '../../components/ui/Btn'
import { AuthHeader } from '../../components/ui/AuthHeader'
import { apiFetch } from '../../lib/api'

const CATEGORIES = [
  'Fashion & textiles', 'Food & groceries', 'Electronics & gadgets', 'Beauty & cosmetics',
  'Building materials', 'Auto parts', 'Pharmacy & health', 'Other',
]

type Props = {
  merchantId: string
  onBack: () => void
  onNext: (name: string, category: string) => void
}

export function ProfileScreen({ merchantId, onBack, onNext }: Props) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState('')
  const [email, setEmail] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const ok = name.trim().length > 1 && cat && emailOk

  const handleContinue = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), businessType: cat }),
      })
      if (!res.ok) throw new Error(await res.text())
      const emailRes = await apiFetch(`/merchants/${merchantId}/billing-email`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!emailRes.ok) throw new Error(await emailRes.text())
      onNext(name.trim(), cat)
    } catch (e) {
      setError((e as Error).message || 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <AuthHeader />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <div className="kicker">Set up your store</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>Tell us about your business.</h1>
        <div style={{ marginTop: 26 }}>
          <div className="field">
            <label>Business name</label>
            <input className="input" placeholder="e.g. Temi Stores" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@business.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>For receipts and billing — we won't spam you.</p>
          </div>
          <div className="field">
            <label>What do you sell?</label>
            <button
              className="input"
              style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: cat ? 'var(--ink)' : 'var(--subtle)' }}
              onClick={() => setOpen(o => !o)}
            >
              {cat || 'Choose a category'}
              {open ? <ChevronUp size={18} strokeWidth={2} color="var(--muted)" /> : <ChevronDown size={18} strokeWidth={2} color="var(--muted)" />}
            </button>
            {open && (
              <div className="card fade-up" style={{ marginTop: 8, overflow: 'hidden', padding: 0 }}>
                {CATEGORIES.map(c => (
                  <button key={c} onClick={() => { setCat(c); setOpen(false) }}
                    style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--line)', fontSize: 15, color: 'var(--ink)', textAlign: 'left', background: 'none' }}>
                    {c}
                    {cat === c && <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          {error && (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
      <div className="footbar">
        <Btn kind="primary" block disabled={!ok} loading={loading} iconRight="arrow-right" onClick={handleContinue}>
          Continue
        </Btn>
      </div>
    </div>
  )
}
