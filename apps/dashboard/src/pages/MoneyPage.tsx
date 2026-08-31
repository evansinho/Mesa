import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScanLine, ArrowDownLeft } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
import { HeroCard, naira } from '../components/ui/HeroCard'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

type Payment = {
  id: string
  customerName?: string | null
  customerPhone: string
  amount: string
  createdAt: string
  orderId: string
  bankName?: string | null
}

type RevenueWindow = { totalRevenue: number }

type SummaryData = {
  revenue?: {
    today?: RevenueWindow
    thisWeek?: RevenueWindow
    thisMonth?: RevenueWindow
    lastMonth?: RevenueWindow
  }
  unpaid?: { count: number; amount: number }
}

type Period = 'today' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'custom'

const PERIODS: Array<{ key: Exclude<Period, 'custom'>; label: string; kicker: string }> = [
  { key: 'today', label: 'Today', kicker: 'Confirmed in · today' },
  { key: 'thisWeek', label: 'Week', kicker: 'Confirmed in · this week' },
  { key: 'thisMonth', label: 'Month', kicker: 'Confirmed in · this month' },
  { key: 'lastMonth', label: 'Last mo.', kicker: 'Confirmed in · last month' },
]

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatPickedDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

export default function MoneyPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const { toast } = useToast()
  const [seg, setSeg] = useState<'in' | 'out'>('in')
  const [period, setPeriod] = useState<Period>('thisWeek')
  const [customFrom, setCustomFrom] = useState(todayDateString)
  const [customTo, setCustomTo] = useState(todayDateString)

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
      return res.json()
    },
  })

  const customRangeValid = customFrom !== '' && customTo !== '' && customFrom <= customTo
  const customRange = useQuery<{ totalRevenue: number }>({
    queryKey: ['analytics-revenue-range', merchantId, customFrom, customTo],
    enabled: !!merchantId && period === 'custom' && customRangeValid,
    queryFn: async () => {
      const res = await apiFetch(
        `/analytics/revenue-range?merchantId=${encodeURIComponent(merchantId)}&from=${customFrom}&to=${customTo}`
      )
      if (!res.ok) return { totalRevenue: 0 }
      return res.json()
    },
  })

  const payments = useQuery<{ payments: Payment[] }>({
    queryKey: ['payments-list', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/payments?merchantId=${encodeURIComponent(merchantId)}&status=CONFIRMED&limit=30`)
      if (!res.ok) return { payments: [] }
      return res.json()
    },
  })

  const periodRevenue = period === 'custom'
    ? (customRange.data?.totalRevenue ?? 0)
    : (summary.data?.revenue?.[period]?.totalRevenue ?? 0)
  const unpaidAmount = summary.data?.unpaid?.amount ?? 0
  const transfersRead = payments.data?.payments.length ?? 0
  const list = payments.data?.payments ?? []
  const kicker = period === 'custom'
    ? (customFrom === customTo
      ? `Confirmed in · ${formatPickedDate(customFrom)}`
      : `Confirmed in · ${formatPickedDate(customFrom)} – ${formatPickedDate(customTo)}`)
    : PERIODS.find(p => p.key === period)!.kicker

  return (
    <div className="pb-tab stagger">
      <TopBar title="Money" sub="Overview" />
      <div className="pad">
        <HeroCard
          kicker={kicker}
          value={periodRevenue}
          footerStats={[
            { label: 'awaiting payment', value: naira(unpaidAmount) },
            { label: 'transfers read', value: transfersRead },
          ]}
        >
          <div className="seg" style={{ marginTop: 14 }}>
            {PERIODS.map(p => (
              <button key={p.key} className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
            <button className={period === 'custom' ? 'on' : ''} onClick={() => setPeriod('custom')}>
              Custom
            </button>
          </div>
          {period === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={e => setCustomFrom(e.target.value)}
                className="date-input"
              />
              <span style={{ color: 'var(--muted-inv)', fontSize: 13 }}>to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={todayDateString()}
                onChange={e => setCustomTo(e.target.value)}
                className="date-input"
              />
            </div>
          )}
        </HeroCard>

        {/* Mesa Lend mini — coming soon */}
        <div className="card card-lg card-pad fade-up flex aic gap12" style={{ marginTop: 18, cursor: 'default' }}>
          <span style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--mint-soft)', color: 'var(--mint-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 20 }}>
            ↗
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Mesa Lend</div>
              <span style={{ fontFamily: 'var(--fm)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', background: 'var(--mint-soft)', color: 'var(--mint-deep)', borderRadius: 99, padding: '2px 8px' }}>Coming soon</span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>Working capital from your sales history</div>
          </div>
        </div>

        <div className="sec-head"><span className="st">Transactions</span></div>
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={seg === 'in' ? 'on' : ''} onClick={() => setSeg('in')}>Money in</button>
          <button className={seg === 'out' ? 'on' : ''} onClick={() => setSeg('out')}>Payouts</button>
        </div>

        {seg === 'in' ? (
          list.length === 0 ? (
            <div className="card card-pad fade-up tcenter" style={{ padding: 36, color: 'var(--muted)' }}>
              <div style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--mint-soft)', color: 'var(--mint-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
                <ArrowDownLeft size={22} strokeWidth={2} />
              </div>
              <div style={{ marginTop: 12, fontWeight: 600, color: 'var(--ink)' }}>No payments yet</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Confirmed payments from customers appear here.</div>
            </div>
          ) : (
            <div className="card card-pad fade-up">
              {list.map(p => (
                <button
                  key={p.id}
                  className="row"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => toast(`Linked to order #${p.orderId.slice(-5).toUpperCase()}`)}
                >
                  <div className="r-ic"><ScanLine size={19} strokeWidth={2} /></div>
                  <div className="r-main">
                    <div className="r-t">{p.customerName ?? p.customerPhone}</div>
                    <div className="r-s">{p.bankName ?? 'Bank transfer'} · {new Date(p.createdAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="r-amt amt-pos">+{naira(Number(p.amount))}</div>
                    <div className="mono subtle" style={{ fontSize: 10.5, marginTop: 2 }}>#{p.orderId.slice(-5).toUpperCase()}</div>
                  </div>
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="card card-pad fade-up tcenter" style={{ padding: 36, color: 'var(--muted)' }}>
            <div style={{ fontSize: 26 }}>↑</div>
            <div style={{ marginTop: 12, fontWeight: 600, color: 'var(--ink)' }}>No payouts yet</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Money you send to suppliers shows here.</div>
          </div>
        )}
      </div>
    </div>
  )
}
