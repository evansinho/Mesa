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

  const error = summary.error?.message ?? topProducts.error?.message
  const loading = summary.isLoading || topProducts.isLoading

  return (
    <main style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0b0f1f 0%, #101828 45%, #182230 100%)',
      color: '#e6edf7',
      padding: '2.5rem',
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    }}>
      <header style={{ marginBottom: '2rem' }}>
        <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
          Dashboard
        </p>
        <h1 style={{ fontSize: 36, margin: '0.5rem 0 1rem' }}>Revenue Summary</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {loading && <span style={{ color: '#94a3b8' }}>Loading…</span>}
          {error && <span style={{ color: '#fca5a5' }}>{error}</span>}
        </div>
      </header>

      <section style={{
        display: 'grid',
        gap: '1rem',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        marginBottom: '2rem',
      }}>
        {[
          { label: 'Today', data: summary.data?.revenue?.today },
          { label: 'Last 7 days', data: summary.data?.revenue?.sevenDays },
          { label: 'Last 30 days', data: summary.data?.revenue?.thirtyDays },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: 'rgba(14, 22, 40, 0.88)',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 18,
              padding: '1.5rem',
            }}
          >
            <p style={{ color: '#94a3b8', margin: 0 }}>{card.label}</p>
            <p style={{ fontSize: 24, margin: '0.5rem 0' }}>
              ₦{Number(card.data?.totalRevenue ?? 0).toLocaleString()}
            </p>
            <p style={{ color: '#94a3b8', margin: 0 }}>{card.data?.totalOrders ?? 0} orders</p>
          </div>
        ))}
      </section>

      <section style={{
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 18,
        padding: '1.5rem',
      }}>
        <h2 style={{ marginTop: 0 }}>Top Products</h2>
        {(topProducts.data ?? []).length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No data yet.</p>
        ) : (
          (topProducts.data ?? []).map((p, idx) => (
            <div key={p.productId} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: idx < (topProducts.data ?? []).length - 1 ? '1px solid rgba(148,163,184,0.1)' : 'none' }}>
              <span>{p.productName}</span>
              <span>₦{Number(p.revenue).toLocaleString()}</span>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
