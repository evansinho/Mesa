import { useState, useEffect, useRef, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'
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

const META_APP_ID = (import.meta.env.VITE_META_APP_ID as string | undefined) ?? ''
const META_CONFIG_ID = (import.meta.env.VITE_META_CONFIG_ID as string | undefined) ?? ''
const META_LOGIN_VERSION = 'v24.0'

const META_CONNECTION_ERROR =
  'Meta could not complete the connection. Keep the popup open, choose your existing WhatsApp Business number, and approve the requested permissions.'
const WHATSAPP_LINK_ERROR =
  'Mesa could not finish linking WhatsApp. Please try again.'
const WHATSAPP_EMBEDDED_SIGNUP_EXTRAS = {
  featureType: 'whatsapp_business_app_onboarding',
  sessionInfoVersion: 3,
}
const WHATSAPP_CONNECT_TIMEOUT_MS = 120_000

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
  merchantId: string
  connected: boolean
  onConnected: () => void
}

export function WhatsAppConnectCard({ merchantId, connected, onConnected }: Props) {
  const [status, setStatus] = useState<ConnectStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const signupData = useRef<EmbeddedSignupData>({})
  const authCode = useRef<string | undefined>(undefined)
  const connectTimeout = useRef<number | undefined>(undefined)
  const completionStarted = useRef(false)

  const clearConnectTimeout = () => {
    if (connectTimeout.current) {
      window.clearTimeout(connectTimeout.current)
      connectTimeout.current = undefined
    }
  }

  const finishConnection = useCallback(async (code?: string) => {
    if (completionStarted.current) return true
    const data = signupData.current
    if (!code && !data.phone_number_id && !data.waba_id) return false

    completionStarted.current = true
    clearConnectTimeout()

    try {
      const body: Record<string, string> = { merchantId }
      if (code) body.code = code
      if (data.phone_number_id) body.phoneNumberId = data.phone_number_id
      if (data.waba_id) body.wabaId = data.waba_id

      const res = await apiFetch('/whatsapp/embedded-signup', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        setStatus('error')
        setErrorMsg(text || WHATSAPP_LINK_ERROR)
        return true
      }
      const signupResult = await res.json() as { ok: boolean; connectionTemplateError?: string }
      if (signupResult.connectionTemplateError) {
        setStatus('error')
        setErrorMsg(`Connected, but template failed: ${signupResult.connectionTemplateError}`)
        return true
      }
      setStatus('success')
      onConnected()
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.')
    }
    return true
  }, [merchantId, onConnected])

  useEffect(() => {
    window.fbAsyncInit = function () {
      window.FB.init({ appId: META_APP_ID, cookie: true, xfbml: true, version: META_LOGIN_VERSION })
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
          signupData.current = readSignupData(payload.data as Record<string, unknown>)
          if (authCode.current) void finishConnection(authCode.current)
        }
      } catch { /* ignore parse errors */ }
    }
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      clearConnectTimeout()
    }
  }, [finishConnection])

  const connectWhatsApp = () => {
    if (!META_APP_ID || !META_CONFIG_ID) {
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
    signupData.current = {}
    authCode.current = undefined
    completionStarted.current = false
    clearConnectTimeout()
    connectTimeout.current = window.setTimeout(() => {
      if (completionStarted.current) return
      setStatus('error')
      setErrorMsg(META_CONNECTION_ERROR)
    }, WHATSAPP_CONNECT_TIMEOUT_MS)

    try {
      window.FB.login((response) => {
        authCode.current = response.authResponse?.code
        void (async () => {
          const completed = await finishConnection(authCode.current)
          if (!completed && response.status === 'not_authorized') {
            clearConnectTimeout()
            setStatus('error')
            setErrorMsg('Permission denied. Make sure to grant all requested permissions.')
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

  const showConnected = connected || status === 'success'

  return (
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
          <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Use your existing business number</p>
        </div>
      </div>

      {showConnected ? (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#25D366', fontWeight: 600, fontSize: '0.9375rem' }}>
            <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#25D366', strokeWidth: 2.5 }}>
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            WhatsApp connected
          </div>
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
              Complete the Meta popup and choose your WhatsApp Business number.
            </p>
          )}
          {status === 'error' && (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>{errorMsg}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
