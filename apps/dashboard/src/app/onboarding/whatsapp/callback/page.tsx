import { Suspense } from 'react'
import CallbackClient from './CallbackClient'

export default function WhatsAppCallbackPage() {
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
      <Suspense fallback={null}>
        <CallbackClient />
      </Suspense>
    </main>
  )
}
