import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { TrendingUp, AlertTriangle, Users, ScanLine, Zap } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import { TopBar } from '../components/ui/TopBar'
import { HeroCard, naira } from '../components/ui/HeroCard'
import { OrderCard, type Order } from '../components/ui/OrderCard'
import { useOverlay } from '../context/OverlayContext'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

type SummaryData = {
  revenue?: { today?: { totalRevenue: number; totalOrders: number }; sevenDays?: { totalRevenue: number; totalOrders: number }; thirtyDays?: { totalRevenue: number; totalOrders: number } }
  customersToday?: number
  unpaid?: { count: number; amount: number }
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).map(p => p[0]).join('').toUpperCase().slice(0, 2) || 'M'
}

function getDayString() {
  return new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' })
}


const QUICK_ACTIONS = [
  { Icon: AlertTriangle, label: 'Low stock',       color: 'var(--amber)',     bg: 'rgba(201,145,42,.1)', to: '/inventory' },
  { Icon: Users,         label: 'Follow up',        color: 'var(--mint-deep)', bg: 'var(--mint-soft)',   to: '/insights' },
  { Icon: ScanLine,      label: 'Read a transfer',  color: 'var(--forest)',    bg: 'var(--paper-2)',     to: '/money' },
  { Icon: Zap,           label: 'Post to status',   color: 'var(--forest)',    bg: 'var(--paper-2)',     to: null as string | null },
]

export default function HomePage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
      return res.json()
    },
  })

  const chartTwo = useQuery<{ days: { date: string; revenue: number; orderCount: number }[] }>({
    queryKey: ['analytics-chart-2d', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/revenue-chart?merchantId=${encodeURIComponent(merchantId)}&days=2`)
      if (!res.ok) return { days: [] }
      return res.json()
    },
  })

  const pending = useQuery<{ orders: Order[] }>({
    queryKey: ['orders-confirm', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/orders?merchantId=${encodeURIComponent(merchantId)}&status=PENDING&limit=5`)
      if (!res.ok) return { orders: [] }
      return res.json()
    },
  })

  const merchant = useQuery<{ merchant: { name: string; config?: Record<string, unknown> } }>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${merchantId}`)
      if (!res.ok) return { merchant: { name: '' } }
      return res.json()
    },
  })

  const confirmMutation = useMutation({
    mutationFn: (orderId: string) => apiFetch(`/orders/${orderId}/confirm`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders-confirm', merchantId] })
      qc.invalidateQueries({ queryKey: ['analytics-summary', merchantId] })
      toast('Order confirmed · customer notified')
    },
  })

  const todayRevenue = summary.data?.revenue?.today?.totalRevenue ?? 0
  const todayOrders = summary.data?.revenue?.today?.totalOrders ?? 0
  const unpaidCount = summary.data?.unpaid?.count ?? 0
  const unpaidAmount = summary.data?.unpaid?.amount ?? 0
  const paidClosed = Math.max(0, todayOrders - unpaidCount)
  const thirtyRevenue = summary.data?.revenue?.thirtyDays?.totalRevenue ?? 0
  // Yesterday delta from 2-day chart
  const chartDays = chartTwo.data?.days ?? []
  const yesterdayRevenue = chartDays.length >= 2 ? chartDays[0].revenue : chartDays.length === 1 ? 0 : null
  const deltaStr = yesterdayRevenue != null && yesterdayRevenue > 0
    ? `${((todayRevenue - yesterdayRevenue) / yesterdayRevenue * 100).toFixed(0)}% vs yesterday`
    : null
  const deltaUp = yesterdayRevenue != null ? todayRevenue >= yesterdayRevenue : true

  const merchantName = merchant.data?.merchant?.name ?? ''
  const firstName = merchantName.split(' ')[0] || 'there'
  const orders = pending.data?.orders ?? []

  const confirmedToday = paidClosed

  return (
    <div className="pb-tab stagger">
      <TopBar
        title={`Hi, ${firstName}`}
        sub={getDayString()}
      />
      <div className="pad">
        <HeroCard
          kicker="Revenue today"
          value={todayRevenue}
          delta={deltaStr ?? undefined}
          deltaUp={deltaUp}
          footerStats={[
            { label: 'orders today', value: todayOrders },
            { label: 'awaiting confirm', value: naira(unpaidAmount) },
            { label: 'paid & closed', value: confirmedToday },
          ]}
        />

        {/* Needs your confirm */}
        <div className="sec-head">
          <span className="st">Needs your confirm</span>
          <Link to="/orders" className="sa">See all →</Link>
        </div>
        {orders.length === 0 ? (
          <div className="card card-pad fade-up" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--mint-deep)' }}>
            <span style={{ fontSize: 18 }}>✓</span>
            <span style={{ fontWeight: 600 }}>You're all caught up</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {orders.slice(0, 2).map(o => (
              <OrderCard
                key={o.id}
                order={o}
                onConfirm={id => confirmMutation.mutate(id)}
                onOpen={id => openOverlay({ type: 'order-detail', orderId: id })}
              />
            ))}
          </div>
        )}


        {/* Mesa Lend — coming soon */}
        <div style={{ background: 'linear-gradient(135deg, var(--forest) 0%, var(--deep) 100%)', borderRadius: 'var(--r-lg)', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14, boxShadow: 'var(--sh-md)', marginTop: 26, cursor: 'default' }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(43,212,138,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <TrendingUp size={22} strokeWidth={2} color="var(--mint)" />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="kicker" style={{ color: 'var(--mint)' }}>Mesa Lend</div>
              <span style={{ fontFamily: 'var(--fm)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', background: 'rgba(43,212,138,.18)', color: 'var(--mint)', borderRadius: 99, padding: '2px 8px' }}>Coming soon</span>
            </div>
            <div style={{ color: '#fff', fontWeight: 600, fontSize: 14, marginTop: 4, lineHeight: 1.4 }}>
              Working capital based on your sales
            </div>
            <div style={{ color: 'var(--muted-inv)', fontSize: 12, marginTop: 2 }}>
              No paperwork. No collateral. Repays from orders.
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="sec-head"><span className="st">Quick actions</span></div>
        <div className="grid2">
          {QUICK_ACTIONS.map(a => (
            a.to ? (
              <Link key={a.label} to={a.to}>
                <div className="card card-pad fade-up" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 38, height: 38, borderRadius: 10, background: a.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <a.Icon size={18} strokeWidth={2} color={a.color} />
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{a.label}</span>
                </div>
              </Link>
            ) : (
              <button key={a.label} onClick={() => toast('Coming soon')} style={{ textAlign: 'left' }}>
                <div className="card card-pad fade-up" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 38, height: 38, borderRadius: 10, background: a.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <a.Icon size={18} strokeWidth={2} color={a.color} />
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{a.label}</span>
                </div>
              </button>
            )
          ))}
        </div>
      </div>
    </div>
  )
}
