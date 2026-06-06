import { useState, useEffect, useRef } from 'react'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'

declare global {
  interface Window {
    FB: {
      init(params: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void
      login(
        callback: (response: FBLoginResponse) => void,
        params: {
          config_id: string
          response_type: string
          override_default_response_type: boolean
          extras?: Record<string, unknown>
        }
      ): void
    }
    fbAsyncInit?: () => void
  }
}

interface FBLoginResponse {
  authResponse?: { code?: string }
  status: string
}

interface EmbeddedSignupData {
  phone_number_id?: string
  waba_id?: string
}

type ConnectStatus = 'idle' | 'loading' | 'success' | 'error'
type EmbeddedSignupResponse = {
  onboardingMessageSent?: boolean
}

const META_APP_ID = (import.meta.env.VITE_META_APP_ID as string | undefined) ?? ''
const META_CONFIG_ID = (import.meta.env.VITE_META_CONFIG_ID as string | undefined) ?? ''
const META_REDIRECT_URI = (import.meta.env.VITE_META_REDIRECT_URI as string | undefined) ?? ''
const INSTAGRAM_REDIRECT_URI = (import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined) ?? ''
const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
]

const META_CONNECTION_ERROR =
  'Meta could not complete the connection. Keep the popup open, choose your existing WhatsApp Business number, and approve the requested permissions.'
const WHATSAPP_LINK_ERROR =
  'Mesa could not finish linking WhatsApp. Please try again.'
const WHATSAPP_EMBEDDED_SIGNUP_EXTRAS = {
  feature: 'whatsapp_embedded_signup',
  sessionInfoVersion: '3',
  featureType: 'whatsapp_business_app_onboarding',
  version: 'v3',
}

export default function WhatsAppPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [status, setStatus] = useState<ConnectStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [onboardingMessageSent, setOnboardingMessageSent] = useState(false)
  const signupData = useRef<EmbeddedSignupData>({})

  useEffect(() => {
    window.fbAsyncInit = function () {
      window.FB.init({ appId: META_APP_ID, cookie: true, xfbml: true, version: 'v20.0' })
    }

    if (!document.getElementById('fb-sdk')) {
      const script = document.createElement('script')
      script.id = 'fb-sdk'
      script.src = 'https://connect.facebook.net/en_US/sdk.js'
      script.async = true
      script.defer = true
      script.crossOrigin = 'anonymous'
      document.body.appendChild(script)
    }

    // Capture WABA + phone number ID from the Embedded Signup popup message
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (
          payload?.type === 'WA_EMBEDDED_SIGNUP'
          && (payload.event === 'FINISH' || payload.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')
          && payload.data
        ) {
          signupData.current = {
            phone_number_id: payload.data.phone_number_id as string | undefined,
            waba_id: payload.data.waba_id as string | undefined,
          }
        }
      } catch { /* ignore parse errors */ }
    }
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [])

  const connectWhatsApp = () => {
    if (!META_APP_ID || !META_CONFIG_ID || !META_REDIRECT_URI) {
      setStatus('error')
      setErrorMsg('Meta connection is not configured. Check the dashboard environment variables.')
      return
    }
    if (!window.FB) {
      setStatus('error')
      setErrorMsg('Facebook SDK not loaded yet — please refresh and try again.')
      return
    }
    setStatus('loading')
    setErrorMsg('')
    setOnboardingMessageSent(false)
    signupData.current = {}

    try {
      window.FB.login((response) => {
        if (!response.authResponse?.code) {
          setStatus('error')
          setErrorMsg(
            response.status === 'not_authorized'
              ? 'Permission denied. Make sure to grant all requested permissions.'
              : META_CONNECTION_ERROR
          )
          return
        }

        const code = response.authResponse.code
        void (async () => {
          try {
            const body: Record<string, string> = {
              merchantId,
              code,
              redirectUri: META_REDIRECT_URI,
            }
            if (signupData.current.phone_number_id) body.phoneNumberId = signupData.current.phone_number_id
            if (signupData.current.waba_id) body.wabaId = signupData.current.waba_id

            const res = await apiFetch('/whatsapp/embedded-signup', {
              method: 'POST',
              body: JSON.stringify(body),
            })
            if (!res.ok) {
              const text = await res.text()
              setStatus('error')
              setErrorMsg(text || WHATSAPP_LINK_ERROR)
              return
            }
            const data = await res.json() as EmbeddedSignupResponse
            setOnboardingMessageSent(data.onboardingMessageSent === true)
            setStatus('success')
          } catch (err) {
            setStatus('error')
            setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.')
          }
        })()
      }, {
        config_id: META_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: WHATSAPP_EMBEDDED_SIGNUP_EXTRAS,
      })
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Could not start Meta connection.')
    }
  }

  const instagramOauthUrl = (() => {
    if (!META_APP_ID || !INSTAGRAM_REDIRECT_URI || !merchantId) return ''
    const state = encodeURIComponent(JSON.stringify({ merchantId }))
    const scope = encodeURIComponent(INSTAGRAM_SCOPES.join(','))
    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`
  })()

  return (
    <>
      <div className="page-header">
        <span className="section-label">Onboarding</span>
        <h1>Connect your existing WhatsApp Business</h1>
        <p style={{ color: 'var(--smoke)', marginTop: 8, lineHeight: 1.65 }}>
          Keep using the WhatsApp Business number your customers already know. Mesa connects it through Meta, then onboarding continues in WhatsApp.
        </p>
      </div>

      <div style={{ display: 'grid', gap: '1rem', maxWidth: 560 }}>
        {/* WhatsApp card */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(37, 211, 102, 0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, fill: 'none', stroke: '#25D366', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '0.9375rem' }}>WhatsApp Business</p>
              <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Use your current WhatsApp Business App number</p>
            </div>
          </div>
          <div style={{
            display: 'grid',
            gap: '0.5rem',
            padding: '0.75rem',
            borderRadius: 8,
            background: 'rgba(16, 185, 129, 0.08)',
            border: '1px solid rgba(16, 185, 129, 0.16)',
            marginBottom: '1rem',
          }}>
            <p style={{ fontSize: '0.8125rem', color: 'var(--ink)', fontWeight: 600 }}>
              This is for merchants already using WhatsApp Business.
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', lineHeight: 1.5 }}>
              Choose the same business number inside Meta. Mesa will not ask you to change numbers or stop using the WhatsApp Business app.
            </p>
          </div>

          {status === 'success' ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#25D366', fontWeight: 600, fontSize: '0.9375rem' }}>
                <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#25D366', strokeWidth: 2.5 }}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                WhatsApp connected successfully
              </div>
              <p style={{ fontSize: '0.8125rem', color: onboardingMessageSent ? 'var(--smoke)' : 'var(--danger)', lineHeight: 1.5 }}>
                {onboardingMessageSent
                  ? 'Continue onboarding in WhatsApp. Mesa has sent the first question there.'
                  : 'WhatsApp is connected, but Mesa could not send the first onboarding question. Try reconnecting or message Mesa on WhatsApp to continue.'}
              </p>
            </div>
          ) : (
            <>
              <button
                onClick={connectWhatsApp}
                className="btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                disabled={status === 'loading' || !merchantId || !META_CONFIG_ID}
              >
                {status === 'loading' ? 'Connecting...' : 'Connect existing WhatsApp Business'}
              </button>
              {status === 'loading' && (
                <p style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: 'var(--smoke)', lineHeight: 1.5 }}>
                  Complete the Meta setup in the popup and pick your existing WhatsApp Business App number when Meta asks for the phone number.
                </p>
              )}
              {status === 'error' && (
                <p style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: 'var(--danger)' }}>{errorMsg}</p>
              )}
            </>
          )}
        </div>

        {/* Instagram card */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(249, 115, 22, 0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, fill: 'none', stroke: '#E1306C', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '0.9375rem' }}>Instagram</p>
              <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Detect orders from Instagram DMs</p>
            </div>
          </div>
          <a
            href={instagramOauthUrl || '#'}
            className="btn-ghost"
            style={{
              width: '100%',
              pointerEvents: instagramOauthUrl ? 'auto' : 'none',
              opacity: instagramOauthUrl ? 1 : 0.5,
              justifyContent: 'center',
            }}
          >
            Connect Instagram
          </a>
        </div>

      </div>
    </>
  )
}
