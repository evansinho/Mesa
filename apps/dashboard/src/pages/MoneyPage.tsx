import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScanLine } from 'lucide-react'
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

type SummaryData = {
  revenue?: { sevenDays?: { totalRevenue: number } }
  unpaid?: { count: number; amount: number }
}

export default function MoneyPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const { toast } = useToast()
  const [seg, setSeg] = useState<'in' | 'out'>('in')

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
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

  const weekRevenue = summary.data?.revenue?.sevenDays?.totalRevenue ?? 0
  const unpaidAmount = summary.data?.unpaid?.amount ?? 0
  const transfersRead = payments.data?.payments.length ?? 0
  const list = payments.data?.payments ?? []

  return (
    <div className="pb-tab stagger">
      <TopBar title="Money" sub="This week" />
      <div className="pad">
        <HeroCard
          kicker="Confirmed in · this week"
          value={weekRevenue}
          footerStats={[
            { label: 'awaiting payment', value: naira(unpaidAmount) },
            { label: 'transfers read', value: transfersRead },
          ]}
        />

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
            <div className="card card-pad tcenter fade-up" style={{ padding: 40, color: 'var(--muted)' }}>No payments yet.</div>
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
