import { useEffect } from 'react'
import { Lockup } from '../../components/ui/Lockup'

export function SplashScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1700)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="splash">
      <div style={{ animation: 'pop .5s var(--ease) both' }}>
        <Lockup markSize={64} wordSize={52} light />
      </div>
      <div className="tagline">Never miss an order</div>
    </div>
  )
}
