import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'
import { WhatsAppConnectCard } from '../../components/connect/WhatsAppConnectCard'
import { InstagramConnectCard } from '../../components/connect/InstagramConnectCard'

type MerchantChannel = { channel: string; status: string }

export default function WhatsAppPage() {
  const navigate = useNavigate()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [channels, setChannels] = useState<MerchantChannel[]>([])

  useEffect(() => {
    if (!merchantId) return
    let cancelled = false
    apiFetch(`/merchants/${merchantId}`)
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((body: { merchant?: { channels?: MerchantChannel[] } }) => {
        if (!cancelled) setChannels(body.merchant?.channels ?? [])
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [merchantId])

  const isConnected = (channel: string) =>
    channels.some(c => c.channel === channel && c.status === 'connected')

  return (
    <>
      <div className="page-header">
        <span className="section-label">Onboarding</span>
        <h1>Connect WhatsApp</h1>
        <p style={{ color: 'var(--smoke)', marginTop: 8, lineHeight: 1.5, maxWidth: 560 }}>
          Keep your current WhatsApp Business number. Mesa connects through Meta and continues setup in WhatsApp.
        </p>
      </div>

      <div style={{ display: 'grid', gap: '1rem', maxWidth: 560 }}>
        <WhatsAppConnectCard
          merchantId={merchantId}
          connected={isConnected('whatsapp')}
          onConnected={() => void navigate({ to: '/onboarding/setup' })}
        />
        <InstagramConnectCard merchantId={merchantId} connected={isConnected('instagram')} />
      </div>
    </>
  )
}
