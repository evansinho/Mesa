import { useState, useEffect, useRef, useCallback } from 'react'
import { Icon } from '../../components/ui/Icon'
import { Btn } from '../../components/ui/Btn'
import { apiFetch } from '../../lib/api'
import { setSession } from '../../lib/auth'


const STEPS = [
  'Connecting your WhatsApp Business app',
  'Importing recent customer chats',
  'Matching products, prices, and orders',
]

const WHATSAPP_EMBEDDED_SIGNUP_EXTRAS = {
  featureType: 'whatsapp_business_app_onboarding',
  sessionInfoVersion: 3,
}

type EmbeddedSignupData = {
  phone_number_id?: string
  waba_id?: string
}

function readSignupData(data: Record<string, unknown> | undefined): EmbeddedSignupData {
  if (!data) return {}
  const phoneNumberIds = data.phone_number_ids
  return {
    phone_number_id:
      (data.phone_number_id as string | undefined)
      ?? (data.business_phone_number_id as string | undefined)
      ?? (Array.isArray(phoneNumberIds) ? phoneNumberIds[0] as string | undefined : undefined),
    waba_id:
      (data.waba_id as string | undefined)
      ?? (data.whatsapp_business_account_id as string | undefined),
  }
}

type Props = {
  session: { token: string; merchantId: string }
  onBack: () => void
  onDone: () => void
}

export function ConnectWAScreen({ session, onBack, onDone }: Props) {
  const [state, setState] = useState<'idle' | 'connecting' | 'done' | 'error'>('idle')
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const sdkLoaded = useRef(false)
  const signupData = useRef<EmbeddedSignupData>({})
  const authCode = useRef<string | undefined>(undefined)
  const completionStarted = useRef(false)

  const finishConnection = useCallback(async (code?: string) => {
    if (completionStarted.current) return true
    const data = signupData.current
    if (!code && !data.phone_number_id && !data.waba_id) return false

    completionStarted.current = true
    setSession(session)
    setError('')
    setState('connecting')

    const body: Record<string, string> = { merchantId: session.merchantId }
    if (code) body.code = code
    if (data.phone_number_id) body.phoneNumberId = data.phone_number_id
    if (data.waba_id) body.wabaId = data.waba_id

    try {
      const res = await apiFetch('/whatsapp/embedded-signup', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${session.token}` },
      })
      if (!res.ok) {
        const text = await res.text()
        completionStarted.current = false
        setState('error')
        setError(text || 'Mesa could not finish linking WhatsApp. Please try again.')
        return true
      }
      setState('done')
    } catch {
      completionStarted.current = false
      setState('error')
      setError('Mesa could not reach the server. Please try again.')
    }
    return true
  }, [session])

  // Load FB SDK
  useEffect(() => {
    if (sdkLoaded.current || document.getElementById('fb-sdk')) return
    sdkLoaded.current = true
    const s = document.createElement('script')
    s.id = 'fb-sdk'
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.onload = () => window.FB?.init({ appId: import.meta.env.VITE_META_APP_ID, version: 'v24.0', cookie: true, xfbml: false })
    document.head.appendChild(s)
  }, [])

  // Animate steps when connecting
  useEffect(() => {
    if (state !== 'connecting') return
    if (step >= STEPS.length - 1) return
    const t = setTimeout(() => setStep(s => s + 1), 950)
    return () => clearTimeout(t)
  }, [state, step])

  // Auto-advance after done
  useEffect(() => {
    if (state !== 'done') return
    const t = setTimeout(onDone, 1300)
    return () => clearTimeout(t)
  }, [state, onDone])

  // Listen for FB embedded signup message
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (!e.origin.includes('facebook.com') && !e.origin.includes('fb.com')) return
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        if (
          data?.type !== 'WA_EMBEDDED_SIGNUP' ||
          (data?.event !== 'FINISH' && data?.event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')
        ) return
        signupData.current = readSignupData(data.data as Record<string, unknown> | undefined)
        const messageCode = (data.data?.code as string | undefined) ?? authCode.current
        if (messageCode) void finishConnection(messageCode)
      } catch {}
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [finishConnection])

  const handleConnect = () => {
    if (!window.FB) {
      setState('error')
      setError('Facebook SDK is still loading. Refresh and try again.')
      return
    }
    signupData.current = {}
    authCode.current = undefined
    completionStarted.current = false
    setError('')
    setStep(0)
    window.FB.login(response => {
      authCode.current = response.authResponse?.code
      if (authCode.current) void finishConnection(authCode.current)
    }, {
      config_id: import.meta.env.VITE_META_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: WHATSAPP_EMBEDDED_SIGNUP_EXTRAS,
    })
  }

  return (
    <div className="screen dark wa-connect-screen">
      {state === 'idle' && (
        <div className="backbar on-dark wa-connect-back">
          <button className="backbtn wa-connect-backbtn" onClick={onBack}>
            <Icon name="chevron-left" size={22} strokeWidth={2.2} />
          </button>
        </div>
      )}
      <div className="screen-scroll pad wa-connect-scroll">
        {state !== 'done' ? (
          <div className="fade-up wa-connect-content">
            <div className="wa-connect-brand">
              <Icon name="message-circle" size={34} strokeWidth={2} color="#fff" />
            </div>
            <h1 className="h-display wa-connect-title">Connect WhatsApp</h1>
            <p className="wa-connect-copy">
              Link your WhatsApp Business app so Mesa can import recent chats, detect orders, and keep your dashboard up to date.
            </p>
            <div className="glass wa-connect-panel">
              {STEPS.map((s, k) => {
                const active = state === 'connecting' && step === k
                const done = state === 'connecting' && step > k
                return (
                  <div key={k} className="wa-connect-step" style={{ borderBottom: k < STEPS.length - 1 ? '1px solid var(--line-inv)' : 0 }}>
                    <span className="wa-connect-step-dot" data-state={done ? 'done' : active ? 'active' : 'idle'}>
                      {done ? <Icon name="check" size={15} strokeWidth={3} />
                        : active ? <span className="spin"><Icon name="loader-circle" size={15} strokeWidth={2.4} /></span>
                        : <span className="wa-connect-step-num">{k + 1}</span>}
                    </span>
                    <span className="wa-connect-step-label" data-lit={done || active ? 'true' : 'false'}>{s}</span>
                  </div>
                )
              })}
            </div>
            {state === 'error' && (
              <p className="wa-connect-error">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="tcenter fade-up" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 92, height: 92, borderRadius: '50%', background: 'var(--mint)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pop .4s var(--ease) both' }}>
              <Icon name="check" size={48} strokeWidth={2.6} color="var(--on-accent)" />
            </div>
            <h1 className="h-display" style={{ color: '#fff', fontSize: 34, marginTop: 26 }}>You're all set.</h1>
            <p style={{ color: 'var(--muted-inv)', fontSize: 16, marginTop: 10 }}>Mesa is now connected to your WhatsApp Business app.</p>
          </div>
        )}
      </div>
      {(state === 'idle' || state === 'error') && (
        <div className="wa-connect-footer">
          <Btn kind="mint" block icon="message-circle" onClick={handleConnect}>Connect WhatsApp Business app</Btn>
          <p className="tcenter wa-connect-note">
            Read-only access · Mesa will not message customers without your approval
          </p>
        </div>
      )}
    </div>
  )
}
