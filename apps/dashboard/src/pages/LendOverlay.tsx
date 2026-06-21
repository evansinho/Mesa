import { useState, useEffect } from 'react'
import { ShieldCheck } from 'lucide-react'
import { BackBar } from '../components/ui/BackBar'
import { Btn } from '../components/ui/Btn'
import { useToast } from '../context/ToastContext'
import { naira } from '../components/ui/HeroCard'
import { useQuery } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

const MONTHS = 4
const RATE = 0.025
const FALLBACK_MAX = 450000

export function LendOverlay({ onBack }: { onBack: () => void }) {
  const { toast } = useToast()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const summary = useQuery<{ revenue?: { thirtyDays?: { totalRevenue: number } } }>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
      return res.json()
    },
  })

  const thirtyRevenue = summary.data?.revenue?.thirtyDays?.totalRevenue ?? 0
  const MAX = thirtyRevenue > 0 ? Math.round(thirtyRevenue * 0.3) : FALLBACK_MAX
  const defaultAmount = Math.min(Math.round(MAX / 2 / 25000) * 25000, MAX)

  const [amount, setAmount] = useState(defaultAmount)

  useEffect(() => {
    setAmount(Math.min(Math.round(MAX / 2 / 25000) * 25000, MAX))
  }, [MAX])
  const monthly = Math.round((amount * (1 + RATE * MONTHS)) / MONTHS)

  return (
    <div className="overlay dark">
      <BackBar onBack={onBack} dark />
      <div className="screen-scroll pad" style={{ paddingBottom: 120 }}>
        <div className="fade-up">
          <div className="kicker" style={{ color: 'var(--mint)' }}>Working capital · unlocked</div>
          <div className="naira" style={{ fontSize: 52, color: '#fff', marginTop: 10 }}>{naira(MAX)}</div>
          <p style={{ color: 'var(--muted-inv)', fontSize: 15, marginTop: 8, lineHeight: 1.5 }}>
            Based on your last 30 days of confirmed sales. No paperwork, no collateral. Repays automatically from incoming orders.
          </p>
        </div>

        <div className="glass fade-up" style={{ padding: 20, marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--fm)', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted-inv)' }}>You take</span>
            <span className="naira" style={{ fontSize: 26, color: 'var(--mint)' }}>{naira(amount)}</span>
          </div>
          <input
            type="range" min={50000} max={MAX} step={25000} value={amount}
            onChange={e => setAmount(+e.target.value)}
            style={{ width: '100%', marginTop: 16, accentColor: '#2bd48a' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--subtle-inv)', marginTop: 6 }}>
            <span>{naira(Math.min(50000, MAX))}</span><span>{naira(MAX)}</span>
          </div>
        </div>

        <div className="glass fade-up" style={{ padding: 4, marginTop: 14 }}>
          {[
            { label: 'Repayment', value: `${MONTHS} months` },
            { label: 'Service fee', value: `${RATE * 100}% / month` },
            { label: 'Auto-deduct / month', value: naira(monthly), accent: true },
          ].map((row, i, arr) => (
            <div key={row.label} style={{ display: 'flex', padding: '14px 16px', borderBottom: i < arr.length - 1 ? '1px solid var(--line-inv)' : 0, justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--muted-inv)', fontSize: 14 }}>{row.label}</span>
              <span className={row.accent ? 'naira' : ''} style={{ color: row.accent ? 'var(--mint)' : '#fff', fontWeight: row.accent ? 800 : 600, fontSize: row.accent ? 16 : 14 }}>{row.value}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 16 }}>
          <ShieldCheck size={16} strokeWidth={2} color="var(--mint)" style={{ marginTop: 1, flexShrink: 0 }} />
          <p style={{ color: 'var(--subtle-inv)', fontSize: 12.5, lineHeight: 1.45 }}>
            Provided through a CBN-licensed partner. Repayments come from your daily sales, never a surprise debit.
          </p>
        </div>
      </div>
      <div className="footbar">
        <Btn kind="mint" block iconRight="arrow-right" onClick={() => toast('Loan request submitted for review')}>
          Take {naira(amount)}
        </Btn>
      </div>
    </div>
  )
}
