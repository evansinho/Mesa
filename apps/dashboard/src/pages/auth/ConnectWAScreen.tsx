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
  sessionInfoVersion: '3',
  version: 'v4',
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
  const [state, setState] = useState<'idle' | 'connecting' | 'done'>('idle')
  const [step, setStep] = useState(0)
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
    setState('connecting')

    const body: Record<string, string> = { merchantId: session.merchantId }
    if (code) body.code = code
    if (data.phone_number_id) body.phoneNumberId = data.phone_number_id
    if (data.waba_id) body.wabaId = data.waba_id

    const res = await apiFetch('/whatsapp/embedded-signup', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (!res.ok) {
      completionStarted.current = false
      console.error('WA signup error:', await res.text())
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
    if (step >= STEPS.length) {
      const t = setTimeout(() => setState('done'), 500)
      return () => clearTimeout(t)
    }
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
    if (!window.FB) { setState('connecting'); return }
    signupData.current = {}
    authCode.current = undefined
    completionStarted.current = false
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
    <div className="screen dark">
      {state === 'idle' && (
        <div className="backbar on-dark">
          <button className="backbtn" onClick={onBack}>
            <Icon name="chevron-left" size={22} strokeWidth={2.2} />
          </button>
        </div>
      )}
      <div className="screen-scroll pad" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingBottom: 30 }}>
        {state !== 'done' ? (
          <div className="fade-up">
            <div style={{ alignSelf: 'flex-start', width: 64, height: 64, borderRadius: 18, background: '#25D366', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24, boxShadow: '0 12px 30px -8px rgba(37,211,102,.5)' }}>
              <Icon name="message-circle" size={34} strokeWidth={2} color="#fff" />
            </div>
            <h1 className="h-display" style={{ color: '#fff', fontSize: 36 }}>Connect WhatsApp</h1>
            <p style={{ color: 'var(--muted-inv)', fontSize: 16, lineHeight: 1.5, marginTop: 14, maxWidth: '32ch' }}>
              Link your WhatsApp Business app so Mesa can import recent chats, detect orders, and keep your dashboard up to date.
            </p>
            <div className="glass" style={{ marginTop: 28, padding: '6px 18px' }}>
              {STEPS.map((s, k) => {
                const active = state === 'connecting' && step === k
                const done = state === 'connecting' && step > k
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 0', borderBottom: k < STEPS.length - 1 ? '1px solid var(--line-inv)' : 0 }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: done ? 'var(--mint)' : active ? 'rgba(43,212,138,.2)' : 'rgba(255,255,255,.08)', color: done ? 'var(--on-accent)' : 'var(--mint)' }}>
                      {done ? <Icon name="check" size={15} strokeWidth={3} />
                        : active ? <span className="spin"><Icon name="loader-circle" size={15} strokeWidth={2.4} /></span>
                        : <span style={{ fontFamily: 'var(--fm)', fontSize: 12, color: 'var(--subtle-inv)' }}>{k + 1}</span>}
                    </span>
                    <span style={{ fontSize: 14.5, color: done || active ? '#fff' : 'var(--subtle-inv)' }}>{s}</span>
                  </div>
                )
              })}
            </div>
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
      {state === 'idle' && (
        <div style={{ padding: '8px 20px 30px' }}>
          <Btn kind="mint" block icon="message-circle" onClick={handleConnect}>Connect WhatsApp Business app</Btn>
          <p className="tcenter" style={{ fontSize: 12, marginTop: 14, color: 'var(--subtle-inv)' }}>
            Read-only access · Mesa will not message customers without your approval
          </p>
        </div>
      )}
    </div>
  )
}
