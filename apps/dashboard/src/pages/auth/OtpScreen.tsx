import { useState, useEffect, useRef } from 'react'
import { CircleCheckBig } from 'lucide-react'
import { AuthHeader } from '../../components/ui/AuthHeader'
import { apiFetch } from '../../lib/api'
import { setSession } from '../../lib/auth'

const LEN = 6

type Props = {
  phone: string
  mode: 'signup' | 'signin'
  onBack: () => void
  onSuccess: (session: { token: string; merchantId: string }) => void
}

export function OtpScreen({ phone, mode, onBack, onSuccess }: Props) {
  const [code, setCode] = useState('')
  const [resend, setResend] = useState(30)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (resend <= 0) return
    const t = setTimeout(() => setResend(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [resend])

  useEffect(() => {
    if (code.length === LEN) verify(code)
  }, [code])

  const verify = async (c: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/auth/verify', { method: 'POST', body: JSON.stringify({ phone, code: c }) })
      if (!res.ok) { const t = await res.text(); throw new Error(t || 'Invalid code') }
      const data = await res.json() as { sessionToken?: string; token?: string; merchantId: string }
      const token = data.sessionToken ?? data.token ?? ''
      const session = { token, merchantId: data.merchantId }
      if (mode === 'signin') setSession(session)
      onSuccess(session)
    } catch (e) {
      setError((e as Error).message || 'Invalid code')
      setCode('')
      setLoading(false)
    }
  }

  const handleResend = async () => {
    await apiFetch('/auth/request', { method: 'POST', body: JSON.stringify({ phone }) })
    setResend(30)
    setCode('')
    setError('')
  }

  const display = phone.replace('+234', '').replace(/(\d{3})(\d{3})(\d{0,5})/, '$1 $2 $3').trim()

  return (
    <div className="screen">
      <AuthHeader />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <div className="kicker">Verify your number</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>Enter the 6-digit code</h1>
        <p className="muted" style={{ fontSize: 15.5, marginTop: 12 }}>
          Sent to <b style={{ color: 'var(--ink)' }}>+234 {display}</b> on WhatsApp.
        </p>
        <div style={{ marginTop: 30 }}>
          <div className="otp">
            {Array.from({ length: LEN }).map((_, k) => (
              <div key={k} className={`cell${code[k] ? ' fill' : ''}${k === code.length && !loading ? ' cur' : ''}`}>
                {code[k] || ''}
              </div>
            ))}
            <input
              ref={inputRef}
              className="otp-input"
              type="text"
              inputMode="numeric"
              maxLength={LEN}
              value={code}
              onChange={e => { if (!loading) setCode(e.target.value.replace(/\D/g, '').slice(0, LEN)) }}
              autoComplete="one-time-code"
            />
          </div>
        </div>
        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          {resend > 0
            ? <span className="subtle mono" style={{ fontSize: 13 }}>Resend code in 0:{resend.toString().padStart(2, '0')}</span>
            : <button className="btn btn-sm" style={{ color: 'var(--mint-deep)', padding: 0 }} onClick={handleResend}>Resend code</button>
          }
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13.5, marginTop: 16 }}>{error}</p>}
        {code.length === LEN && !error && !loading && (
          <div style={{ marginTop: 28, display: 'flex', alignItems: 'center', gap: 9, color: 'var(--mint-deep)' }} className="fade-up">
            <CircleCheckBig size={20} strokeWidth={2.2} />
            <span style={{ fontWeight: 600 }}>Verified</span>
          </div>
        )}
      </div>
    </div>
  )
}
