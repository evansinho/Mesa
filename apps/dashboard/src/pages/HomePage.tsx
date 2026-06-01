import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type RevenuePeriod = { totalRevenue: number; totalOrders: number }
type SummaryData = {
  revenue?: {
    today?: RevenuePeriod
    sevenDays?: RevenuePeriod
    thirtyDays?: RevenuePeriod
  }
  customersToday?: number
  unpaid?: { count: number; amount: number }
}
type ChartDay = { date: string; revenue: number; orderCount: number }
type TopProduct = { productId: string; productName: string; revenue: number; unitsSold: number }

function RevenueChart({ days }: { days: ChartDay[] }) {
  const maxRevenue = Math.max(...days.map(d => d.revenue), 1)
  const barHeight = 72

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: barHeight, marginBottom: 4 }}>
        {days.map((day) => {
          const h = Math.max((day.revenue / maxRevenue) * barHeight, day.revenue > 0 ? 3 : 0)
          const label = new Date(day.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
          return (
            <div
              key={day.date}
              title={`${label}\n₦${day.revenue.toLocaleString()} · ${day.orderCount} order${day.orderCount !== 1 ? 's' : ''}`}
              style={{
                flex: 1,
                height: h,
                background: day.revenue > 0 ? 'var(--forest)' : 'var(--ghost)',
                borderRadius: '2px 2px 0 0',
                cursor: 'default',
                transition: 'opacity 0.15s',
                opacity: 0.85,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85' }}
            />
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--smoke)' }}>
        <span>{new Date(days[0]?.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</span>
        <span>Today</span>
      </div>
    </div>
  )
}

const PERIOD_CARDS = [
  { label: 'Last 7 days', key: 'sevenDays' as const },
  { label: 'Last 30 days', key: 'thirtyDays' as const },
]

export default function HomePage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<SummaryData>
    },
  })

  const chart = useQuery<{ days: ChartDay[] }>({
    queryKey: ['analytics-chart', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/revenue-chart?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return { days: [] }
      return res.json() as Promise<{ days: ChartDay[] }>
    },
  })

  const topProducts = useQuery<TopProduct[]>({
    queryKey: ['analytics-top-products', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/top-products?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return []
      const data = await res.json() as { products?: TopProduct[] }
      return data.products ?? []
    },
  })

  const unpaid = summary.data?.unpaid
  const todayRevenue = summary.data?.revenue?.today?.totalRevenue ?? 0
  const todayOrders = summary.data?.revenue?.today?.totalOrders ?? 0
  const customersToday = summary.data?.customersToday ?? 0

  return (
    <>
      <div className="page-header">
        <span className="section-label">Dashboard</span>
        <h1>Overview</h1>
        {summary.isLoading && <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>}
      </div>

      {/* Unpaid alert */}
      {unpaid && unpaid.count > 0 && (
        <div style={{
          background: 'rgba(220, 38, 38, 0.07)',
          border: '1px solid rgba(220, 38, 38, 0.18)',
          borderRadius: 'var(--radius)',
          padding: '0.75rem 1.1rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1.25rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)', flexShrink: 0 }} />
            <p style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>
              <strong style={{ color: 'var(--danger)' }}>₦{unpaid.amount.toLocaleString()}</strong>
              {' '}awaiting payment &mdash; {unpaid.count} order{unpaid.count !== 1 ? 's' : ''}
            </p>
          </div>
          <Link to="/orders" style={{ fontSize: '0.8125rem', color: 'var(--forest)', fontWeight: 600, whiteSpace: 'nowrap', textDecoration: 'none' }}>
            View orders →
          </Link>
        </div>
      )}

      {/* Today stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Revenue today', value: `₦${todayRevenue.toLocaleString()}` },
          { label: 'Orders today', value: todayOrders.toString() },
          { label: 'Customers today', value: customersToday.toString() },
        ].map(stat => (
          <div key={stat.label} className="card" style={{ padding: '1rem 1.1rem' }}>
            <p style={{ fontSize: '0.75rem', color: 'var(--smoke)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {stat.label}
            </p>
            <p style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-head)' }}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* 30-day revenue chart */}
      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}>
            Revenue — last 30 days
          </h2>
          <span style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>
            ₦{(summary.data?.revenue?.thirtyDays?.totalRevenue ?? 0).toLocaleString()} total
          </span>
        </div>
        {chart.data && chart.data.days.length > 0
          ? <RevenueChart days={chart.data.days} />
          : <div style={{ height: 80, display: 'flex', alignItems: 'center', color: 'var(--smoke)', fontSize: '0.875rem' }}>No orders yet.</div>
        }
      </div>

      {/* 7d / 30d aggregate cards */}
      <div className="revenue-grid" style={{ marginBottom: '1.25rem' }}>
        {PERIOD_CARDS.map(({ label, key }) => {
          const data = summary.data?.revenue?.[key]
          return (
            <div key={key} className="revenue-card">
              <p className="revenue-card-label">{label}</p>
              <p className="revenue-card-value">₦{Number(data?.totalRevenue ?? 0).toLocaleString()}</p>
              <p className="revenue-card-sub">{data?.totalOrders ?? 0} orders</p>
            </div>
          )
        })}
      </div>

      {/* Top products */}
      <div className="table-container">
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ghost)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}>
            Top products · 30 days
          </h2>
        </div>
        {(topProducts.data ?? []).length === 0 ? (
          <div style={{ padding: '1.5rem', color: 'var(--smoke)', fontSize: '0.875rem' }}>No orders yet.</div>
        ) : (
          (topProducts.data ?? []).map((p, idx, arr) => (
            <div
              key={p.productId}
              className="flex-between"
              style={{
                padding: '0.875rem 1.25rem',
                borderBottom: idx < arr.length - 1 ? '1px solid rgba(184,201,193,0.3)' : 'none',
                fontSize: '0.9rem',
              }}
            >
              <div>
                <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{p.productName}</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--smoke)', marginLeft: 8 }}>{p.unitsSold} sold</span>
              </div>
              <span style={{ fontWeight: 600, color: 'var(--forest)' }}>₦{Number(p.revenue).toLocaleString()}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}
