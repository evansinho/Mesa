import { useCountUp } from '../../hooks/useCountUp'

type Stat = { label: string; value: string | number }

type Props = {
  kicker: string
  value: number
  animated?: boolean
  delta?: string
  deltaUp?: boolean
  footerStats?: Stat[]
  children?: React.ReactNode
}

export function naira(n: number) {
  return `₦${Math.round(n).toLocaleString('en-NG')}`
}

export function HeroCard({ kicker, value, animated = true, delta, deltaUp, footerStats, children }: Props) {
  const display = useCountUp(value, 1100, animated)
  return (
    <div className="hero-card">
      <div className="grain" />
      <div style={{ position: 'relative' }}>
        <div className="hc-k">{kicker}</div>
        <div className="hc-num">{naira(display)}</div>
        {delta && (
          <div className="hc-delta">
            <span>{deltaUp ? '↑' : '↓'}</span> {delta}
          </div>
        )}
        {footerStats && footerStats.length > 0 && (
          <div className="hc-foot">
            {footerStats.map((s, i) => (
              <div key={i} className="hc-stat">
                <div className="v">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
                <div className="l">{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
