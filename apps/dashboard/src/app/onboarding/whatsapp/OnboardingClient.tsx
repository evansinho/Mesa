'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const META_OAUTH_VERSION = 'v20.0'
const META_SCOPES = [
  'whatsapp_business_messaging',
  'whatsapp_business_management',
]

function buildOAuthUrl(params: {
  appId: string
  redirectUri: string
  merchantId: string
}) {
  const state = encodeURIComponent(JSON.stringify({ merchantId: params.merchantId }))
  const scope = encodeURIComponent(META_SCOPES.join(','))
  const redirect = encodeURIComponent(params.redirectUri)
  return `https://www.facebook.com/${META_OAUTH_VERSION}/dialog/oauth?client_id=${params.appId}&redirect_uri=${redirect}&response_type=code&scope=${scope}&state=${state}`
}

export default function OnboardingClient() {
  const searchParams = useSearchParams()
  const merchantId = searchParams.get('merchantId') ?? ''

  const appId = process.env.NEXT_PUBLIC_META_APP_ID ?? ''
  const redirectUri = process.env.NEXT_PUBLIC_META_REDIRECT_URI ?? ''

  const oauthUrl = useMemo(() => {
    if (!appId || !redirectUri || !merchantId) return ''
    return buildOAuthUrl({ appId, redirectUri, merchantId })
  }, [appId, redirectUri, merchantId])

  return (
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
        Mesa · Embedded Signup
      </p>
      <h1 style={{ fontSize: 36, margin: '0.75rem 0 0.5rem' }}>Connect your WhatsApp Business</h1>
      <p style={{ color: '#cbd5f5', lineHeight: 1.6, marginBottom: '1.5rem' }}>
        This links your existing WhatsApp Business number so Mesa can silently detect orders and payments.
      </p>

      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <a
          href={oauthUrl || '#'}
          style={{
            pointerEvents: oauthUrl ? 'auto' : 'none',
            opacity: oauthUrl ? 1 : 0.5,
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
          Continue with Meta
        </a>
        <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>
          You will be redirected to Meta to approve WhatsApp access.
        </p>
      </div>
    </section>
  )
}
