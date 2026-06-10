import { useState } from 'react'
import { Lock } from 'lucide-react'
import { Btn } from '../../components/ui/Btn'
import { BackBar } from '../../components/ui/BackBar'
import { apiFetch } from '../../lib/api'

type Props = {
  mode: 'signup' | 'signin'
  onBack: () => void
  onNext: (phone: string) => void
}

function fmt(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d.replace(/(\d{3})(\d{3})(\d{0,5})/, (_m, a, b, c) => c ? `${a} ${b} ${c}` : b ? `${a} ${b}` : a)
}

export function PhoneScreen({ mode, onBack, onNext }: Props) {
  const [num, setNum] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const digits = num.replace(/\D/g, '')
  const ok = digits.length >= 10

  const handleSend = async () => {
    setLoading(true)
    setError('')
    try {
      const phone = '+234' + digits.replace(/^0/, '')
      const res = await apiFetch('/auth/request', { method: 'POST', body: JSON.stringify({ phone }) })
      if (!res.ok) { const t = await res.text(); throw new Error(t) }
      onNext(phone)
    } catch (e) {
      setError((e as Error).message || 'Failed to send code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <BackBar onBack={onBack} />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <div className="kicker">{mode === 'signin' ? 'Welcome back' : 'Create your account'}</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>
          {mode === 'signin' ? 'Sign in to Mesa.' : "What's your business number?"}
        </h1>
        <p className="muted" style={{ fontSize: 15.5, lineHeight: 1.5, marginTop: 12, maxWidth: '32ch' }}>
          {mode === 'signin'
            ? 'Enter the WhatsApp number on your Mesa account and we\'ll send a code to verify it.'
            : 'Use the WhatsApp number your customers already message. We\'ll send a code to verify it.'}
        </p>
        <div style={{ marginTop: 28 }}>
          <div className="field">
            <label>WhatsApp business number</label>
            <div className="input-group">
              <span className="prefix">🇳🇬 +234</span>
              <input
                className="input"
                inputMode="numeric"
                placeholder="801 234 5678"
                value={num}
                onChange={e => setNum(fmt(e.target.value))}
                autoFocus
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 4 }}>
            <Lock size={15} strokeWidth={2} color="var(--subtle)" style={{ marginTop: 2, flexShrink: 0 }} />
            <p className="subtle" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              Mesa connects in read-only mode. We can see order messages, we can never send messages or move money on your behalf.
            </p>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13.5, marginTop: 12 }}>{error}</p>}
        </div>
      </div>
      <div className="footbar">
        <Btn kind="primary" block disabled={!ok} loading={loading} iconRight="arrow-right" onClick={handleSend}>
          Send code
        </Btn>
      </div>
    </div>
  )
}
