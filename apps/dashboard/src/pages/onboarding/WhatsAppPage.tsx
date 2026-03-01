import { useMemo } from 'react'
import { getSession } from '../../lib/auth'

const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
]

const META_OAUTH_VERSION = 'v20.0'

function buildInstagramOAuthUrl(appId: string, redirectUri: string, merchantId: string) {
  const state = encodeURIComponent(JSON.stringify({ merchantId }))
  const scope = encodeURIComponent(INSTAGRAM_SCOPES.join(','))
  const redirect = encodeURIComponent(redirectUri)
  return `https://www.facebook.com/${META_OAUTH_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&response_type=code&scope=${scope}&state=${state}`
}

function build360dialogUrl(partnerId: string, redirectUri: string, merchantId: string, sandbox: boolean) {
  const base = 'https://hub.360dialog.io/dashboard/app'
  const params = new URLSearchParams({
    redirect_url: redirectUri,
    state: merchantId,
    ...(sandbox ? { sandbox: 'true' } : {}),
  })
  return `${base}/${partnerId}/permissions?${params.toString()}`
}

export default function WhatsAppPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const partnerId = (import.meta.env.VITE_D360_PARTNER_ID as string | undefined) ?? ''
  const waRedirectUri = (import.meta.env.VITE_D360_REDIRECT_URI as string | undefined) ?? ''
  const sandbox = import.meta.env.VITE_D360_SANDBOX === 'true'

  const appId = (import.meta.env.VITE_META_APP_ID as string | undefined) ?? ''
  const instagramRedirectUri = (import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined) ?? ''

  const whatsappUrl = useMemo(() => {
    if (!partnerId || !waRedirectUri || !merchantId) return ''
    return build360dialogUrl(partnerId, waRedirectUri, merchantId, sandbox)
  }, [partnerId, waRedirectUri, merchantId, sandbox])

  const instagramOauthUrl = useMemo(() => {
    if (!appId || !instagramRedirectUri || !merchantId) return ''
    return buildInstagramOAuthUrl(appId, instagramRedirectUri, merchantId)
  }, [appId, instagramRedirectUri, merchantId])

  return (
    <main style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0b0f1f 0%, #101828 45%, #182230 100%)',
      color: '#e6edf7',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    }}>
      <section style={{
        width: '100%',
        maxWidth: 680,
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 24,
        padding: '2.5rem',
        boxShadow: '0 20px 80px rgba(8, 12, 24, 0.55)',
      }}>
        <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
          Mesa · Channel Setup
        </p>
        <h1 style={{ fontSize: 36, margin: '0.75rem 0 0.5rem' }}>Connect your channels</h1>
        <p style={{ color: '#cbd5f5', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Link WhatsApp and Instagram so Mesa can silently detect orders and payments on both channels.
        </p>

        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <a
            href={whatsappUrl || '#'}
            style={{
              pointerEvents: whatsappUrl ? 'auto' : 'none',
              opacity: whatsappUrl ? 1 : 0.5,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.9rem 1.5rem',
              borderRadius: 999,
              background: 'linear-gradient(120deg, #22c55e, #16a34a)',
              color: '#04110a',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
          >
            Connect WhatsApp
          </a>
          <a
            href={instagramOauthUrl || '#'}
            style={{
              pointerEvents: instagramOauthUrl ? 'auto' : 'none',
              opacity: instagramOauthUrl ? 1 : 0.5,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.9rem 1.5rem',
              borderRadius: 999,
              background: 'linear-gradient(120deg, #f97316, #ea580c)',
              color: '#160b03',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
          >
            Connect Instagram
          </a>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>
            WhatsApp uses 360dialog. Instagram uses Meta OAuth. You will be redirected to complete the connection.
          </p>
        </div>
      </section>
    </main>
  )
}