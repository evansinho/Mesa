import { useState, useEffect, useRef, useCallback } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'
import { useMonoConnect } from '../lib/useMonoConnect'
// Deliberately not imported from @mesa/types: that package compiles to
// CommonJS, and pnpm's workspace symlinks make Vite/Rollup's commonjs
// interop misfire at build time — it silences the build warning but leaves
// a raw `require()` call in the browser bundle, which crashes the whole app
// on load (confirmed in production). Keep this list in sync with
// packages/types/src/events.ts's TRACKING_LINK_PLATFORMS by hand — it's four
// stable strings, not worth fighting the bundler over.
const TRACKING_LINK_PLATFORMS = ['tiktok', 'instagram', 'facebook', 'website'] as const
type TrackingLinkPlatform = typeof TRACKING_LINK_PLATFORMS[number]

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
// Instagram API with Instagram Login uses its own companion app ID, distinct
// from VITE_META_APP_ID (which is the WhatsApp Meta app) — never conflate.
const INSTAGRAM_APP_ID = (import.meta.env.VITE_INSTAGRAM_APP_ID as string | undefined) ?? ''
const INSTAGRAM_REDIRECT_URI = (import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined) ?? ''
const META_LOGIN_VERSION = 'v24.0'
const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
]

const META_CONNECTION_ERROR =
  'Meta could not complete the connection. Keep the popup open, choose your existing WhatsApp Business number, and approve the requested permissions.'
const WHATSAPP_LINK_ERROR = 'Mesa could not finish linking WhatsApp. Please try again.'
const WHATSAPP_EMBEDDED_SIGNUP_EXTRAS = {
  featureType: 'whatsapp_business_app_onboarding',
  sessionInfoVersion: 3,
}
const WHATSAPP_CONNECT_TIMEOUT_MS = 120_000

function readWhatsappSignupData(data: Record<string, unknown> | undefined) {
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

type MerchantChannel = { channel: string; channelAccountId: string; status: string; connectedAt: string; merchantRecipientId?: string | null }
type MerchantData = {
  id: string; name: string; phone: string; email: string | null; businessType: string | null
  subscriptionTier: string; config: Record<string, unknown>; channels: MerchantChannel[]
}
type SubscriptionData = { tier: string; ordersThisMonth: number; limit: number }

const TIER_LABEL: Record<string, string> = { starter: 'Starter', growth: 'Growth', business: 'Business' }
const ORDER_LIMITS: Record<string, number> = { starter: 100, growth: 400, business: 1200 }
const PLATFORM_LABEL: Record<TrackingLinkPlatform, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', website: 'Website',
}
type TrackingLink = { id: string; platform: string; slug: string; url: string; clickCount: number; createdAt: string }

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })
}

const sh: React.CSSProperties = {
  fontFamily: 'var(--fd)', fontWeight: 700, fontSize: '1rem', color: 'var(--ink)', marginBottom: '1rem',
}
const lbl: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.3rem',
  fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500,
}
const inp: React.CSSProperties = {
  padding: '0.45rem 0.7rem',
  borderRadius: 'var(--r-sm)',
  border: '1.5px solid var(--line-2)',
  background: 'var(--paper-2)',
  color: 'var(--ink)',
  fontFamily: 'var(--fb)',
  fontSize: '0.9rem',
  outline: 'none',
  width: '100%',
}
const sm: React.CSSProperties = { padding: '0.45rem 1rem', fontSize: '0.8125rem' }
const sec: React.CSSProperties = { marginBottom: '1.25rem' }
const body: React.CSSProperties = { padding: '1.25rem 1.5rem' }

export default function SettingsPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()

  const signupData = useRef<{ phone_number_id?: string; waba_id?: string }>({})
  const authCode = useRef<string | undefined>(undefined)
  const connectTimeout = useRef<number | undefined>(undefined)
  const completionStarted = useRef(false)
  const [waConnecting, setWaConnecting] = useState(false)
  const [waError, setWaError] = useState('')

  const clearConnectTimeout = () => {
    if (connectTimeout.current) { window.clearTimeout(connectTimeout.current); connectTimeout.current = undefined }
  }

  const finishWhatsAppReconnect = useCallback(async (code?: string) => {
    if (completionStarted.current) return true
    const data = signupData.current
    if (!code && !data.phone_number_id && !data.waba_id) return false
    completionStarted.current = true
    clearConnectTimeout()
    try {
      const bodyData: Record<string, string> = { merchantId }
      if (code) bodyData.code = code
      if (data.phone_number_id) bodyData.phoneNumberId = data.phone_number_id
      if (data.waba_id) bodyData.wabaId = data.waba_id
      const res = await apiFetch('/whatsapp/embedded-signup', { method: 'POST', body: JSON.stringify(bodyData) })
      if (!res.ok) { const text = await res.text(); setWaError(text || WHATSAPP_LINK_ERROR) }
      else { await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] }) }
    } catch { setWaError('An unexpected error occurred.') }
    finally { setWaConnecting(false) }
    return true
  }, [merchantId, queryClient])

  useEffect(() => {
    window.fbAsyncInit = function () {
      window.FB.init({ appId: META_APP_ID, cookie: true, xfbml: true, version: META_LOGIN_VERSION })
    }
    if (!document.getElementById('fb-sdk')) {
      const script = document.createElement('script')
      script.id = 'fb-sdk'; script.src = 'https://connect.facebook.net/en_US/sdk.js'
      script.async = true; script.defer = true; script.crossOrigin = 'anonymous'
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
          signupData.current = readWhatsappSignupData(payload.data as Record<string, unknown>)
          if (authCode.current) void finishWhatsAppReconnect(authCode.current)
        }
      } catch { /* ignore */ }
    }
    window.addEventListener('message', handleMessage)
    return () => { window.removeEventListener('message', handleMessage); clearConnectTimeout() }
  }, [finishWhatsAppReconnect])

  const { data: merchantResponse, isLoading } = useQuery<{ merchant: MerchantData }>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}`)
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<{ merchant: MerchantData }>
    },
  })
  const merchant = merchantResponse?.merchant

  const mono = useMonoConnect({
    merchantId,
    name: merchant?.name,
    email: merchant?.email,
    onConnected: () => { void queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] }) },
  })
  const [billingEmail, setBillingEmail] = useState('')
  const [billingEmailSaving, setBillingEmailSaving] = useState(false)
  const [billingEmailError, setBillingEmailError] = useState<string | null>(null)

  async function saveBillingEmail(e: React.FormEvent) {
    e.preventDefault()
    setBillingEmailSaving(true)
    setBillingEmailError(null)
    const res = await apiFetch(`/merchants/${merchantId}/billing-email`, {
      method: 'POST',
      body: JSON.stringify({ email: billingEmail }),
    })
    setBillingEmailSaving(false)
    if (!res.ok) {
      setBillingEmailError(await res.text() || 'Failed to save email.')
      return
    }
    await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
  }

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

  const [name, setName] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [infoSaving, setInfoSaving] = useState(false)
  const [infoMsg, setInfoMsg] = useState('')

  useEffect(() => {
    if (merchant) { setName(merchant.name); setBusinessType(merchant.businessType ?? '') }
  }, [merchant])

  async function saveBusinessInfo() {
    setInfoSaving(true); setInfoMsg('')
    const res = await apiFetch(`/merchants/${merchantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim(), businessType: businessType.trim() || null }),
    })
    setInfoSaving(false)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
      setInfoMsg('Saved'); setTimeout(() => setInfoMsg(''), 2000)
    } else { setInfoMsg('Failed to save') }
  }


  type BankAccount = { bankName: string; bankCode: string; accountNumber: string; accountName: string; verified?: boolean }
  const existingBankAccount = merchant?.config?.bankAccount as BankAccount | undefined

  const [banks, setBanks] = useState<Array<{ name: string; code: string }>>([])
  const [bank, setBank] = useState<{ name: string; code: string } | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  const [bankSearch, setBankSearch] = useState('')
  const [accNum, setAccNum] = useState('')
  const [accName, setAccName] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [paySaving, setPaySaving] = useState(false)
  const [payMsg, setPayMsg] = useState('')
  const bankAccountOk = bank && accNum.length === 10 && accName.trim().length > 1

  useEffect(() => {
    apiFetch('/banks')
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((body: { banks: Array<{ name: string; code: string }> }) => setBanks(body.banks))
      .catch(() => undefined)
  }, [])

  // Pre-fill from whatever's already saved (e.g. from onboarding) — only
  // once, when it first loads, so the merchant can still edit freely
  // afterward without their in-progress typing being clobbered by a refetch.
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current || !existingBankAccount) return
    prefilled.current = true
    setBank({ name: existingBankAccount.bankName, code: existingBankAccount.bankCode })
    setAccNum(existingBankAccount.accountNumber)
    setAccName(existingBankAccount.accountName)
    setResolved(!!existingBankAccount.verified)
  }, [existingBankAccount])

  // Auto-verify the account name from Paystack once we have bank + 10 digits
  // — same flow as onboarding's PaymentStep.
  useEffect(() => {
    if (!bank || accNum.length !== 10) { setResolved(false); setResolveFailed(false); return }
    if (existingBankAccount?.bankCode === bank.code && existingBankAccount.accountNumber === accNum) return
    let cancelled = false
    setResolving(true)
    setResolveFailed(false)
    apiFetch('/banks/resolve', {
      method: 'POST',
      body: JSON.stringify({ accountNumber: accNum, bankCode: bank.code }),
    })
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((body: { accountName: string }) => {
        if (cancelled) return
        setAccName(body.accountName)
        setResolved(true)
      })
      .catch(() => { if (!cancelled) { setResolved(false); setResolveFailed(true) } })
      .finally(() => { if (!cancelled) setResolving(false) })
    return () => { cancelled = true }
  }, [bank, accNum, existingBankAccount])

  const filteredBanks = bankSearch.trim()
    ? banks.filter(b => b.name.toLowerCase().includes(bankSearch.trim().toLowerCase()))
    : banks

  async function saveBankAccount() {
    setPaySaving(true); setPayMsg('')
    const res = await apiFetch(`/merchants/${merchantId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        config: {
          bankAccount: {
            bankName: bank!.name,
            bankCode: bank!.code,
            accountNumber: accNum,
            accountName: accName.trim(),
            verified: resolved,
          },
        },
      }),
    })
    setPaySaving(false)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
      setPayMsg('Saved'); setTimeout(() => setPayMsg(''), 2000)
    } else { setPayMsg('Failed to save') }
  }

  const { data: trackingLinksData } = useQuery({
    queryKey: ['tracking-links', merchantId],
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${merchantId}/tracking-links`)
      if (!res.ok) throw new Error('Failed to load tracking links')
      return res.json() as Promise<{ links: TrackingLink[] }>
    },
    enabled: !!merchantId,
  })
  const trackingLinks = trackingLinksData?.links ?? []
  const [creatingPlatform, setCreatingPlatform] = useState<TrackingLinkPlatform | null>(null)
  const [trackingLinkError, setTrackingLinkError] = useState('')
  const [copiedSlug, setCopiedSlug] = useState('')

  async function createTrackingLink(platform: TrackingLinkPlatform) {
    setCreatingPlatform(platform)
    setTrackingLinkError('')
    const res = await apiFetch(`/merchants/${merchantId}/tracking-links`, {
      method: 'POST',
      body: JSON.stringify({ platform }),
    })
    setCreatingPlatform(null)
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['tracking-links', merchantId] })
    } else {
      setTrackingLinkError('Could not create link — please try again')
    }
  }

  function copyTrackingLink(link: TrackingLink) {
    navigator.clipboard.writeText(link.url).then(() => {
      setCopiedSlug(link.slug)
      setTimeout(() => setCopiedSlug(''), 2000)
    })
  }

  function reconnectWhatsApp() {
    if (!META_APP_ID || !META_CONFIG_ID) { setWaError('Meta connection is not configured.'); return }
    if (!window.FB) { setWaError('Facebook SDK not loaded yet. Please refresh and try again.'); return }
    setWaConnecting(true); setWaError('')
    signupData.current = {}; authCode.current = undefined
    completionStarted.current = false; clearConnectTimeout()
    connectTimeout.current = window.setTimeout(() => {
      if (completionStarted.current) return
      setWaConnecting(false); setWaError(META_CONNECTION_ERROR)
    }, WHATSAPP_CONNECT_TIMEOUT_MS)
    window.FB.login((response) => {
      authCode.current = response.authResponse?.code
      void (async () => {
        const completed = await finishWhatsAppReconnect(authCode.current)
        if (!completed && response.status === 'not_authorized') {
          clearConnectTimeout(); setWaConnecting(false)
          setWaError('Permission denied. Make sure to grant all requested permissions.')
        }
      })()
    }, {
      config_id: META_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: WHATSAPP_EMBEDDED_SIGNUP_EXTRAS,
    })
  }

  const instagramOauthUrl = (() => {
    if (!INSTAGRAM_APP_ID || !INSTAGRAM_REDIRECT_URI || !merchantId) return ''
    const state = encodeURIComponent(JSON.stringify({ merchantId }))
    const scope = encodeURIComponent(INSTAGRAM_SCOPES.join(','))
    return `https://www.instagram.com/oauth/authorize?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`
  })()

  const [waDisconnecting, setWaDisconnecting] = useState(false)
  const [igDisconnecting, setIgDisconnecting] = useState(false)

  async function disconnectChannel(channel: 'whatsapp' | 'instagram') {
    if (!window.confirm(`Disconnect ${channel === 'whatsapp' ? 'WhatsApp' : 'Instagram'}? Mesa will stop sending and receiving messages on this channel until you reconnect.`)) return
    const setDisconnecting = channel === 'whatsapp' ? setWaDisconnecting : setIgDisconnecting
    setDisconnecting(true)
    try {
      const res = await apiFetch(`/${channel}/disconnect`, { method: 'POST', body: JSON.stringify({ merchantId }) })
      if (res.ok) await queryClient.invalidateQueries({ queryKey: ['merchant', merchantId] })
    } finally {
      setDisconnecting(false)
    }
  }

  async function deleteAccount() {
    const confirmed = window.prompt('This will permanently delete your account and all data.\nType DELETE to confirm:')
    if (confirmed !== 'DELETE') return
    const res = await apiFetch(`/merchants/${merchantId}`, { method: 'DELETE' })
    if (res.ok) { localStorage.removeItem('mesa_session'); window.location.href = '/sign-up' }
  }

  const waChannel = merchant?.channels?.find(c => c.channel === 'whatsapp' && c.status === 'connected')
  const igChannel = merchant?.channels?.find(c => c.channel === 'instagram' && c.status === 'connected')
  const tier = sub?.tier ?? merchant?.subscriptionTier ?? 'starter'
  const ordersThisMonth = sub?.ordersThisMonth ?? 0
  const orderLimit = sub?.limit ?? ORDER_LIMITS[tier] ?? 100
  const usagePct = Math.min((ordersThisMonth / orderLimit) * 100, 100)

  const tierBadge = tier === 'business' ? 'badge badge-green'
    : tier === 'growth' ? 'badge badge-yellow'
    : 'badge badge-ink'

  if (isLoading) {
    return (
      <div className="pb-tab">
        <TopBar title="Settings" sub="Account" />
        <div className="pad" style={{ paddingTop: 40, textAlign: 'center', color: 'var(--subtle)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <div className="pb-tab stagger">
      <TopBar title="Settings" sub="Account" />
      <div className="pad">
        <div>

          {/* Business Info */}
          <div style={sec}>
            <div className="card fade-up" style={body}>
              <div style={sh}>Business Info</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
                <label style={lbl}>Business name<input style={inp} value={name} onChange={e => setName(e.target.value)} /></label>
                <label style={lbl}>Business type<input style={inp} value={businessType} onChange={e => setBusinessType(e.target.value)} placeholder="e.g. Food & Grocery" /></label>
                <label style={lbl}>Phone number<input style={{ ...inp, opacity: 0.6, cursor: 'not-allowed' }} value={merchant?.phone ?? ''} readOnly /></label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button className="btn btn-sm btn-primary" style={sm} onClick={saveBusinessInfo} disabled={infoSaving}>
                  {infoSaving ? 'Saving…' : 'Save'}
                </button>
                {infoMsg === 'Saved' && <span style={{ fontSize: '0.8125rem', color: 'var(--mint-deep)' }}>{infoMsg}</span>}
              </div>
              {infoMsg && infoMsg !== 'Saved' && (
                <div className="alert-error">
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{infoMsg}</span>
                </div>
              )}
            </div>
          </div>

          {/* Connected Channels */}
          <div style={sec}>
            <div className="card fade-up" style={body}>
              <div style={sh}>Connected Channels</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(37,211,102,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#25D366', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9rem' }}>WhatsApp Business</div>
                    {waChannel
                      ? <div style={{ fontSize: '0.78rem', color: 'var(--mint-deep)' }}>Connected · {formatDate(waChannel.connectedAt)}</div>
                      : <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>Connect your existing WhatsApp Business App number</div>}
                  </div>
                  <button className="btn btn-sm btn-ghost" style={{ ...sm, flexShrink: 0 }} onClick={reconnectWhatsApp} disabled={waConnecting || !META_CONFIG_ID}>
                    {waConnecting ? 'Connecting...' : 'Reconnect'}
                  </button>
                  {waChannel && (
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ ...sm, flexShrink: 0, color: 'var(--danger)' }}
                      onClick={() => disconnectChannel('whatsapp')}
                      disabled={waDisconnecting}
                    >
                      {waDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  )}
                </div>
                {waError && (
                  <div className="alert-error" style={{ marginTop: -2 }}>
                    <AlertCircle size={16} strokeWidth={2} />
                    <span>{waError}</span>
                  </div>
                )}

                <div style={{ height: 1, background: 'var(--line)' }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(225,48,108,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#E1306C', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9rem' }}>Instagram</div>
                    {igChannel
                      ? <div style={{ fontSize: '0.78rem', color: 'var(--mint-deep)' }}>Connected · {formatDate(igChannel.connectedAt)}</div>
                      : <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>Not connected</div>}
                    {igChannel && !igChannel.merchantRecipientId && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 2 }}>
                        Mesa can't notify you on Instagram yet — tap Reconnect for a one-time activation link.
                      </div>
                    )}
                  </div>
                  <a
                    href={instagramOauthUrl || '#'}
                    className="btn btn-sm btn-ghost"
                    style={{ ...sm, textDecoration: 'none', flexShrink: 0, opacity: instagramOauthUrl ? 1 : 0.5, pointerEvents: instagramOauthUrl ? 'auto' : 'none' }}
                  >
                    Reconnect
                  </a>
                  {igChannel && (
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ ...sm, flexShrink: 0, color: 'var(--danger)' }}
                      onClick={() => disconnectChannel('instagram')}
                      disabled={igDisconnecting}
                    >
                      {igDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Subscription */}
          <div style={sec}>
            <div className="card fade-up" style={body}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <div style={sh}>Subscription</div>
                <span className={tierBadge}>{TIER_LABEL[tier] ?? tier}</span>
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>
                {ordersThisMonth} / {orderLimit} orders this month
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', marginBottom: '1rem' }}>
                <div style={{
                  height: '100%', width: `${usagePct}%`, borderRadius: 4,
                  background: usagePct > 90 ? 'var(--danger)' : 'var(--forest)',
                  transition: 'width 0.3s',
                }} />
              </div>
              <button className="btn btn-sm btn-ghost" style={{ ...sm, opacity: 0.5, cursor: 'not-allowed' }} disabled title="Coming soon">
                Upgrade plan
              </button>
            </div>
          </div>

          {/* Payment Info */}
          <div style={sec}>
            <div className="card fade-up" style={body}>
              <div style={sh}>Payment Info</div>
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.35rem' }}>Mono bank account</div>
                {merchant?.config?.monoAccountId ? (
                  <div style={{ fontSize: '0.875rem', color: 'var(--ink)' }}>Connected — account linked</div>
                ) : !mono.available ? (
                  <div style={{ fontSize: '0.875rem', color: 'var(--ink)' }}>Not connected</div>
                ) : merchant && !merchant.email ? (
                  <form onSubmit={saveBillingEmail} style={{ display: 'grid', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>Mono requires a billing email before it can link your account.</span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        className="form-input"
                        type="email"
                        value={billingEmail}
                        onChange={e => setBillingEmail(e.target.value)}
                        placeholder="you@business.com"
                        required
                        style={{ flex: 1 }}
                      />
                      <button className="btn btn-sm btn-primary" style={sm} disabled={billingEmailSaving}>
                        {billingEmailSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                    {billingEmailError && (
                      <div className="alert-error">
                        <AlertCircle size={16} strokeWidth={2} />
                        <span>{billingEmailError}</span>
                      </div>
                    )}
                  </form>
                ) : (
                  <>
                    <button
                      className="btn btn-sm btn-primary"
                      style={sm}
                      onClick={mono.open}
                      disabled={!merchant || mono.status === 'connecting'}
                    >
                      {mono.status === 'connecting' ? 'Connecting…' : 'Connect bank account'}
                    </button>
                    {mono.status === 'error' && mono.error && (
                      <div className="alert-error" style={{ marginTop: '0.5rem' }}>
                        <AlertCircle size={16} strokeWidth={2} />
                        <span>{mono.error}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.35rem' }}>Bank account</div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Shown to customers when they complete an order</span>
              </div>
              <label style={lbl}>
                Bank
                <button
                  className="form-input"
                  style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}
                  onClick={() => setBankOpen(o => !o)}
                >
                  <span>{bank?.name || (banks.length ? 'Select your bank' : 'Loading banks…')}</span>
                  {bankOpen ? <ChevronUp size={18} strokeWidth={2} color="var(--muted)" /> : <ChevronDown size={18} strokeWidth={2} color="var(--muted)" />}
                </button>
                {bankOpen && (
                  <div className="card fade-up" style={{ marginTop: 8, overflow: 'hidden', padding: 0 }}>
                    <input
                      className="form-input"
                      autoFocus
                      placeholder="Search banks…"
                      value={bankSearch}
                      onChange={e => setBankSearch(e.target.value)}
                      style={{ border: 'none', borderBottom: '1px solid var(--line)', borderRadius: 0 }}
                    />
                    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {filteredBanks.map(b => (
                        <button key={b.code} onClick={() => { setBank(b); setBankOpen(false); setBankSearch(''); setAccName('') }}
                          style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 14, color: 'var(--ink)', textAlign: 'left', background: 'none' }}>
                          {b.name}
                          {bank?.code === b.code && <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />}
                        </button>
                      ))}
                      {filteredBanks.length === 0 && (
                        <p className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>No banks match "{bankSearch}"</p>
                      )}
                    </div>
                  </div>
                )}
              </label>
              <label style={{ ...lbl, marginTop: '0.75rem' }}>
                Account number
                <input
                  className="form-input"
                  inputMode="numeric"
                  placeholder="10-digit account number"
                  value={accNum}
                  maxLength={10}
                  onChange={e => { setAccNum(e.target.value.replace(/\D/g, '').slice(0, 10)); setAccName('') }}
                />
              </label>
              <label style={{ ...lbl, marginTop: '0.75rem' }}>
                Account name
                {resolved ? (
                  <div className="form-input" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink)' }}>
                    <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />
                    <span>{accName}</span>
                  </div>
                ) : (
                  <input
                    className="form-input"
                    placeholder={resolving ? 'Verifying account…' : 'Name on the account'}
                    value={accName}
                    disabled={resolving}
                    onChange={e => setAccName(e.target.value)}
                  />
                )}
                {resolving && <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Checking with the bank…</span>}
                {resolveFailed && <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Couldn't verify automatically — check the number, or type the account name yourself.</span>}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
                <button className="btn btn-sm btn-primary" style={sm} onClick={saveBankAccount} disabled={paySaving || !bankAccountOk}>
                  {paySaving ? 'Saving…' : 'Save'}
                </button>
                {payMsg === 'Saved' && <span style={{ fontSize: '0.8125rem', color: 'var(--mint-deep)' }}>{payMsg}</span>}
              </div>
              {payMsg && payMsg !== 'Saved' && (
                <div className="alert-error" style={{ marginTop: '0.5rem' }}>
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{payMsg}</span>
                </div>
              )}
            </div>
          </div>

          {/* Tracking Links */}
          <div style={sec}>
            <div className="card fade-up" style={body}>
              <div style={sh}>Tracking Links</div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.6 }}>
                Put a platform's link in that platform's bio. Mesa does its best to tag orders that come through
                — clicks that reach WhatsApp with the pre-filled message intact are marked "confirmed"; others are "estimated".
              </div>
              {trackingLinks.length > 0 && (
                <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
                  {trackingLinks.map(link => (
                    <div key={link.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--line-2)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 0 }}>
                        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ink)' }}>
                          {PLATFORM_LABEL[link.platform as TrackingLinkPlatform] ?? link.platform}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {link.url}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{link.clickCount} click{link.clickCount === 1 ? '' : 's'}</span>
                        <button className="btn btn-sm btn-ghost" style={sm} onClick={() => copyTrackingLink(link)}>
                          {copiedSlug === link.slug ? <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" /> : 'Copy'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {TRACKING_LINK_PLATFORMS.filter(p => !trackingLinks.some(l => l.platform === p)).map(platform => (
                  <button
                    key={platform}
                    className="btn btn-sm btn-primary"
                    style={sm}
                    onClick={() => createTrackingLink(platform)}
                    disabled={creatingPlatform === platform}
                  >
                    {creatingPlatform === platform ? 'Creating…' : `Create ${PLATFORM_LABEL[platform]} link`}
                  </button>
                ))}
              </div>
              {trackingLinkError && (
                <div className="alert-error" style={{ marginTop: '0.5rem' }}>
                  <AlertCircle size={16} strokeWidth={2} />
                  <span>{trackingLinkError}</span>
                </div>
              )}
            </div>
          </div>

          {/* Danger Zone */}
          <div style={sec}>
            <div className="card fade-up" style={{ ...body, border: '1.5px solid rgba(192,73,47,.25)', background: 'rgba(192,73,47,.03)' }}>
              <div style={{ ...sh, color: 'var(--danger)' }}>Danger Zone</div>
              <div style={{ fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.6 }}>
                Permanently delete your account and all associated data. This cannot be undone.
              </div>
              <button
                className="btn btn-sm btn-ghost"
                style={{ ...sm, color: 'var(--danger)', borderColor: 'rgba(192,73,47,.3)' }}
                onClick={deleteAccount}
              >
                Delete account
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
