import { useMemo } from 'react'
import { getSession } from '../../lib/auth'

const META_APP_ID = (import.meta.env.VITE_META_APP_ID as string | undefined) ?? ''
const WHATSAPP_REDIRECT_URI = (import.meta.env.VITE_META_REDIRECT_URI as string | undefined) ?? ''
const INSTAGRAM_REDIRECT_URI = (import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined) ?? ''
const WHATSAPP_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management']
const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_manage_messages', 'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement']

function buildOAuthUrl(params: { appId: string; redirectUri: string; merchantId: string; scopes: string[] }) {
  const state = encodeURIComponent(JSON.stringify({ merchantId: params.merchantId }))
  const scope = encodeURIComponent(params.scopes.join(','))
  return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${params.appId}&redirect_uri=${encodeURIComponent(params.redirectUri)}&response_type=code&scope=${scope}&state=${state}`
}

export default function WhatsAppPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const whatsappOauthUrl = useMemo(() => {
    if (!META_APP_ID || !WHATSAPP_REDIRECT_URI || !merchantId) return ''
    return buildOAuthUrl({ appId: META_APP_ID, redirectUri: WHATSAPP_REDIRECT_URI, merchantId, scopes: WHATSAPP_SCOPES })
  }, [merchantId])

  const instagramOauthUrl = useMemo(() => {
    if (!META_APP_ID || !INSTAGRAM_REDIRECT_URI || !merchantId) return ''
    return buildOAuthUrl({ appId: META_APP_ID, redirectUri: INSTAGRAM_REDIRECT_URI, merchantId, scopes: INSTAGRAM_SCOPES })
  }, [merchantId])

  return (
    <>
      <div className="page-header">
        <span className="section-label">Onboarding</span>
        <h1>Connect your channels</h1>
        <p style={{ color: 'var(--smoke)', marginTop: 8, lineHeight: 1.65 }}>
          Link WhatsApp and Instagram so Mesa can silently detect orders and payments on both channels.
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
              <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Detect orders from WhatsApp messages</p>
            </div>
          </div>

          <a
            href={whatsappOauthUrl || '#'}
            className="btn-primary"
            style={{ width: '100%', justifyContent: 'center', pointerEvents: whatsappOauthUrl ? 'auto' : 'none', opacity: whatsappOauthUrl ? 1 : 0.5 }}
          >
            Connect WhatsApp
          </a>
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

        <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', lineHeight: 1.6 }}>
          You will be redirected to Meta to approve access. Mesa only reads messages — it never sends messages on your behalf.
        </p>
      </div>
    </>
  )
}
