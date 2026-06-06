import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

declare global {
  interface Window {
    FB: {
      init(params: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void
      login(
        callback: (response: { authResponse?: { code?: string }; status: string }) => void,
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
  sessionInfoVersion: '3',
  featureType: 'whatsapp_business_app_onboarding',
}

type MerchantChannel = {
  channel: string
  channelAccountId: string
  status: string
  connectedAt: string
}

type MerchantData = {
  id: string
  name: string
  phone: string
  businessType: string | null
  subscriptionTier: string
  config: Record<string, unknown>
  channels: MerchantChannel[]
}

type SubscriptionData = {
  tier: string
  ordersThisMonth: number
  limit: number
}

const TIER_LABEL: Record<string, string> = { starter: 'Starter', growth: 'Growth', business: 'Business' }
const ORDER_LIMITS: Record<string, number> = { starter: 100, growth: 400, business: 1200 }

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })
}

const sectionStyle: React.CSSProperties = { marginBottom: '1.25rem' }
const cardStyle: React.CSSProperties = { padding: '1.25rem 1.5rem' }
const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.3rem',
  fontSize: '0.8125rem', color: 'var(--smoke)', fontWeight: 500,
}
const inputStyle: React.CSSProperties = {
  padding: '0.45rem 0.7rem',
  borderRadius: 'var(--radius-sm)',
  border: '1.5px solid var(--ghost)',
  background: 'var(--cream)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-body)',
  fontSize: '0.9rem',
  outline: 'none',
  width: '100%',
}
const smallBtn: React.CSSProperties = { padding: '0.45rem 1rem', fontSize: '0.8125rem' }
const sectionHeadStyle: React.CSSProperties = {
  fontFamily: 'var(--font-head)',
  fontSize: '1rem',
  fontWeight: 700,
  color: 'var(--ink)',
  marginBottom: '1rem',
}

export default function SettingsPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()

  // FB SDK for WhatsApp reconnect
  const signupData = useRef<{ phone_number_id?: string; waba_id?: string }>({})
  const [waConnecting, setWaConnecting] = useState(false)
  const [waError, setWaError] = useState('')

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
      } catch { /* ignore */ }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Data fetches
  const { data: merchant, isLoading } = useQuery<MerchantData>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}`)
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json() as { merchant: MerchantData }
      return json.merchant
    },
  })

  const { data: sub } = useQuery<SubscriptionData>({
    queryKey: ['subscription', merchantId],
    enabled: !!merchantId,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/subscription?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return { tier: 'starter', ordersThisMonth: 0, limit: 100 }
      return res.json() as Promise<SubscriptionData>
    },
  })

  // Business Info state
  const [name, setName] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [infoSaving, setInfoSaving] = useState(false)
  const [infoMsg, setInfoMsg] = useState('')

  useEffect(() => {
    if (merchant) {
      setName(merchant.name)
      setBusinessType(merchant.businessType ?? '')
    }
  }, [merchant])

  async function saveBusinessInfo() {
    setInfoSaving(true)
    setInfoMsg('')
    const res = await apiFetch(`/merchants/${merchantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim(), businessType: businessType.trim() || null }),
    })
    setInfoSaving(false)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
      setInfoMsg('Saved')
      setTimeout(() => setInfoMsg(''), 2000)
    } else {
      setInfoMsg('Failed to save')
    }
  }

  // Bot pause state
  const [pauseSaving, setPauseSaving] = useState(false)
  const isPaused = merchant?.config?.paused === true

  async function togglePause() {
    setPauseSaving(true)
    await apiFetch(`/merchants/${merchantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ config: { paused: !isPaused } }),
    })
    await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
    setPauseSaving(false)
  }

  // Payment instructions state
  const [payInstructions, setPayInstructions] = useState('')
  const [paySaving, setPaySaving] = useState(false)
  const [payMsg, setPayMsg] = useState('')

  useEffect(() => {
    if (merchant) setPayInstructions((merchant.config?.paymentInstructions as string | undefined) ?? '')
  }, [merchant])

  async function savePaymentInstructions() {
    setPaySaving(true)
    setPayMsg('')
    const res = await apiFetch(`/merchants/${merchantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ config: { paymentInstructions: payInstructions } }),
    })
    setPaySaving(false)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
      setPayMsg('Saved')
      setTimeout(() => setPayMsg(''), 2000)
    } else {
      setPayMsg('Failed to save')
    }
  }

  // WhatsApp reconnect
  function reconnectWhatsApp() {
    if (!META_APP_ID || !META_CONFIG_ID || !META_REDIRECT_URI) {
      setWaError('Meta connection is not configured. Check the dashboard environment variables.')
      return
    }
    if (!window.FB) { setWaError('Facebook SDK not loaded yet. Please refresh and try again.'); return }
    setWaConnecting(true)
    setWaError('')
    signupData.current = {}
    window.FB.login((response) => {
      if (!response.authResponse?.code) {
        setWaConnecting(false)
        setWaError(
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
            setWaError(text || WHATSAPP_LINK_ERROR)
          }
          else { await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] }) }
        } catch {
          setWaError('An unexpected error occurred.')
        } finally {
          setWaConnecting(false)
        }
      })()
    }, {
      config_id: META_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: WHATSAPP_EMBEDDED_SIGNUP_EXTRAS,
    })
  }

  // Instagram OAuth URL
  const instagramOauthUrl = (() => {
    if (!META_APP_ID || !INSTAGRAM_REDIRECT_URI || !merchantId) return ''
    const state = encodeURIComponent(JSON.stringify({ merchantId }))
    const scope = encodeURIComponent(INSTAGRAM_SCOPES.join(','))
    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`
  })()

  // Delete account
  async function deleteAccount() {
    const confirmed = window.prompt('This will permanently delete your account and all data.\nType DELETE to confirm:')
    if (confirmed !== 'DELETE') return
    const res = await apiFetch(`/merchants/${merchantId}`, { method: 'DELETE' })
    if (res.ok) {
      localStorage.removeItem('mesa_session')
      window.location.href = '/sign-up'
    }
  }

  // Channel helpers
  const waChannel = merchant?.channels.find(c => c.channel === 'whatsapp')
  const igChannel = merchant?.channels.find(c => c.channel === 'instagram')

  // Subscription
  const tier = sub?.tier ?? merchant?.subscriptionTier ?? 'starter'
  const ordersThisMonth = sub?.ordersThisMonth ?? 0
  const orderLimit = sub?.limit ?? ORDER_LIMITS[tier] ?? 100
  const usagePct = Math.min((ordersThisMonth / orderLimit) * 100, 100)

  const tierBadgeClass = tier === 'business' ? 'badge badge-green'
    : tier === 'growth' ? 'badge badge-yellow'
    : 'badge'

  if (isLoading) {
    return (
      <div className="page-header">
        <span className="section-label">Settings</span>
        <h1>Account Settings</h1>
        <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <span className="section-label">Settings</span>
        <h1>Account Settings</h1>
      </div>

      {/* Business Info */}
      <div style={sectionStyle}>
        <div className="card" style={cardStyle}>
          <p style={sectionHeadStyle}>Business Info</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
            <label style={labelStyle}>
              Business name
              <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label style={labelStyle}>
              Business type
              <input style={inputStyle} value={businessType} onChange={e => setBusinessType(e.target.value)} placeholder="e.g. Food & Grocery" />
            </label>
            <label style={labelStyle}>
              Phone number
              <input style={{ ...inputStyle, opacity: 0.6, cursor: 'not-allowed' }} value={merchant?.phone ?? ''} readOnly />
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="btn-primary" style={smallBtn} onClick={saveBusinessInfo} disabled={infoSaving}>
              {infoSaving ? 'Saving…' : 'Save'}
            </button>
            {infoMsg && <span style={{ fontSize: '0.8125rem', color: infoMsg === 'Saved' ? 'var(--forest)' : 'var(--danger)' }}>{infoMsg}</span>}
          </div>
        </div>
      </div>

      {/* Connected Channels */}
      <div style={sectionStyle}>
        <div className="card" style={cardStyle}>
          <p style={sectionHeadStyle}>Connected Channels</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            {/* WhatsApp */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(37,211,102,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#25D366', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9rem' }}>WhatsApp Business</p>
                {waChannel
                  ? <p style={{ fontSize: '0.78rem', color: 'var(--forest)' }}>Connected · {formatDate(waChannel.connectedAt)}</p>
                  : <p style={{ fontSize: '0.78rem', color: 'var(--smoke)' }}>Connect your existing WhatsApp Business App number</p>}
              </div>
              <button className="btn-ghost" style={{ ...smallBtn, flexShrink: 0 }} onClick={reconnectWhatsApp} disabled={waConnecting || !META_CONFIG_ID}>
                {waConnecting ? 'Connecting...' : 'Reconnect'}
              </button>
            </div>
            {waError && <p style={{ fontSize: '0.8125rem', color: 'var(--danger)', marginTop: -8 }}>{waError}</p>}

            <div style={{ height: 1, background: 'var(--ghost)' }} />

            {/* Instagram */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(225,48,108,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#E1306C', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9rem' }}>Instagram</p>
                {igChannel
                  ? <p style={{ fontSize: '0.78rem', color: 'var(--forest)' }}>Connected · {formatDate(igChannel.connectedAt)}</p>
                  : <p style={{ fontSize: '0.78rem', color: 'var(--smoke)' }}>Not connected</p>}
              </div>
              <a
                href={instagramOauthUrl || '#'}
                className="btn-ghost"
                style={{ ...smallBtn, textDecoration: 'none', flexShrink: 0, opacity: instagramOauthUrl ? 1 : 0.5, pointerEvents: instagramOauthUrl ? 'auto' : 'none' }}
              >
                Reconnect
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Subscription */}
      <div style={sectionStyle}>
        <div className="card" style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <p style={sectionHeadStyle}>Subscription</p>
            <span className={tierBadgeClass}>{TIER_LABEL[tier] ?? tier}</span>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', marginBottom: '0.5rem' }}>
            {ordersThisMonth} / {orderLimit} orders this month
          </p>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--ghost)', overflow: 'hidden', marginBottom: '1rem' }}>
            <div style={{
              height: '100%',
              width: `${usagePct}%`,
              borderRadius: 4,
              background: usagePct > 90 ? 'var(--danger)' : 'var(--forest)',
              transition: 'width 0.3s',
            }} />
          </div>
          <button className="btn-ghost" style={{ ...smallBtn, opacity: 0.5, cursor: 'not-allowed' }} disabled title="Coming soon">
            Upgrade plan
          </button>
        </div>
      </div>

      {/* Bot Settings */}
      <div style={sectionStyle}>
        <div className="card" style={cardStyle}>
          <p style={sectionHeadStyle}>Bot Settings</p>
          {isPaused && (
            <div style={{
              background: 'rgba(220,38,38,0.07)',
              border: '1px solid rgba(220,38,38,0.18)',
              borderRadius: 'var(--radius)',
              padding: '0.6rem 0.9rem',
              fontSize: '0.8125rem',
              color: 'var(--danger)',
              marginBottom: '1rem',
            }}>
              Bot is paused — customers will not receive automated replies.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9rem' }}>Pause automated replies</p>
              <p style={{ fontSize: '0.78rem', color: 'var(--smoke)', marginTop: 2 }}>Stop the bot from processing customer messages</p>
            </div>
            <button
              onClick={togglePause}
              disabled={pauseSaving}
              aria-label={isPaused ? 'Resume bot' : 'Pause bot'}
              style={{
                position: 'relative',
                width: 44,
                height: 24,
                borderRadius: 12,
                border: 'none',
                background: isPaused ? 'var(--danger)' : 'var(--ghost)',
                cursor: pauseSaving ? 'wait' : 'pointer',
                transition: 'background 0.2s',
                flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute',
                top: 3,
                left: isPaused ? 23 : 3,
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.2s',
              }} />
            </button>
          </div>
        </div>
      </div>

      {/* Payment Info */}
      <div style={sectionStyle}>
        <div className="card" style={cardStyle}>
          <p style={sectionHeadStyle}>Payment Info</p>

          <div style={{ marginBottom: '1rem' }}>
            <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', fontWeight: 500, marginBottom: '0.35rem' }}>
              Mono bank account
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--ink)' }}>
              {merchant?.config?.monoAccountId
                ? `Connected — account linked`
                : 'Not connected — set up in onboarding'}
            </p>
          </div>

          <label style={{ ...labelStyle, marginBottom: '0.75rem' }}>
            Payment instructions
            <textarea
              value={payInstructions}
              onChange={e => setPayInstructions(e.target.value)}
              rows={3}
              placeholder="e.g. Send payment to 0123456789 (GTBank) in the name of Acme Stores"
              style={{
                ...inputStyle,
                resize: 'vertical',
                minHeight: 80,
                fontFamily: 'var(--font-body)',
              }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--smoke)' }}>Shown to customers when they complete an order</span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="btn-primary" style={smallBtn} onClick={savePaymentInstructions} disabled={paySaving}>
              {paySaving ? 'Saving…' : 'Save'}
            </button>
            {payMsg && <span style={{ fontSize: '0.8125rem', color: payMsg === 'Saved' ? 'var(--forest)' : 'var(--danger)' }}>{payMsg}</span>}
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div style={sectionStyle}>
        <div
          className="card"
          style={{ ...cardStyle, border: '1.5px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.03)' }}
        >
          <p style={{ ...sectionHeadStyle, color: 'var(--danger)' }}>Danger Zone</p>
          <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', marginBottom: '1rem' }}>
            Permanently delete your account and all associated data — products, orders, conversations, and channel connections.
            This cannot be undone.
          </p>
          <button
            className="btn-ghost"
            style={{ ...smallBtn, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.3)' }}
            onClick={deleteAccount}
          >
            Delete account
          </button>
        </div>
      </div>
    </>
  )
}
