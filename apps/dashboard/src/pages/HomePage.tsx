import { useQuery } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type RevenuePeriod = { totalRevenue: number; totalOrders: number }
type SummaryData = {
  revenue?: {
    today?: RevenuePeriod
    sevenDays?: RevenuePeriod
    thirtyDays?: RevenuePeriod
  }
}
type TopProduct = { productId: string; productName: string; revenue: number }

const CARDS = [
  { label: 'Today',       key: 'today'      as const },
  { label: 'Last 7 days', key: 'sevenDays'  as const },
  { label: 'Last 30 days',key: 'thirtyDays' as const },
]

export default function HomePage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<SummaryData>
    },
  })

  const topProducts = useQuery<TopProduct[]>({
    queryKey: ['analytics-top-products', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/top-products?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return []
      const data = await res.json() as { products?: TopProduct[] }
      return data.products ?? []
    },
  })

  const loading = summary.isLoading || topProducts.isLoading
  const error = summary.error?.message ?? topProducts.error?.message

  return (
    <>
      <div className="page-header">
        <span className="section-label">Dashboard</span>
        <h1>Revenue Summary</h1>
        {loading && <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>}
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: 6 }}>{error}</p>}
      </div>

      {/* Revenue cards */}
      <div className="revenue-grid" style={{ marginBottom: '2rem' }}>
        {CARDS.map(({ label, key }) => {
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
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ghost)' }}>
          <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--ink)' }}>
            Top Products
          </h2>
        </div>
        {(topProducts.data ?? []).length === 0 ? (
          <div style={{ padding: '1.5rem', color: 'var(--smoke)' }}>No data yet.</div>
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
              <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{p.productName}</span>
              <span style={{ fontWeight: 600, color: 'var(--forest)' }}>₦{Number(p.revenue).toLocaleString()}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}
