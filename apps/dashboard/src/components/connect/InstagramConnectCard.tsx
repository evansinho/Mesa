const META_APP_ID = (import.meta.env.VITE_META_APP_ID as string | undefined) ?? ''
const INSTAGRAM_REDIRECT_URI = (import.meta.env.VITE_META_INSTAGRAM_REDIRECT_URI as string | undefined) ?? ''
const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
]

type Props = {
  merchantId: string
  connected: boolean
}

export function InstagramConnectCard({ merchantId, connected }: Props) {
  const instagramOauthUrl = (() => {
    if (!META_APP_ID || !INSTAGRAM_REDIRECT_URI || !merchantId) return ''
    const state = encodeURIComponent(JSON.stringify({ merchantId }))
    const scope = encodeURIComponent(INSTAGRAM_SCOPES.join(','))
    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`
  })()

  return (
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

      {connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#E1306C', fontWeight: 600, fontSize: '0.9375rem' }}>
          <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: '#E1306C', strokeWidth: 2.5 }}>
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Instagram connected
        </div>
      ) : (
        <a
          href={instagramOauthUrl || '#'}
          className="btn btn-ghost btn-lg btn-block"
          style={{
            textDecoration: 'none',
            pointerEvents: instagramOauthUrl ? 'auto' : 'none',
            opacity: instagramOauthUrl ? 1 : 0.5,
          }}
        >
          Connect Instagram
        </a>
      )}
    </div>
  )
}
