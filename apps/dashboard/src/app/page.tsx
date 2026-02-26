import React from 'react'

export default function DashboardPage() {
  return <AnalyticsHome />
}

function AnalyticsHome() {
  const [merchantId, setMerchantId] = React.useState('')
  const [summary, setSummary] = React.useState<{ revenue?: { today?: { totalRevenue: number; totalOrders: number }; sevenDays?: { totalRevenue: number; totalOrders: number }; thirtyDays?: { totalRevenue: number; totalOrders: number } } } | null>(null)
  const [topProducts, setTopProducts] = React.useState<Array<{ productId: string; productName: string; revenue: number }>>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    const [summaryRes, topRes] = await Promise.all([
      fetch(`/api/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`),
      fetch(`/api/analytics/top-products?merchantId=${encodeURIComponent(merchantId)}`),
    ])

    if (!summaryRes.ok) {
      setError(await summaryRes.text())
      setLoading(false)
      return
    }

    const summaryData = await summaryRes.json()
    const topData = topRes.ok ? await topRes.json() : { products: [] }
    setSummary(summaryData)
    setTopProducts(topData.products ?? [])
    setLoading(false)
  }

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
          <input
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            placeholder="Enter merchant ID"
            style={{
              minWidth: 320,
              padding: '0.85rem 1rem',
              borderRadius: 12,
              border: '1px solid rgba(148, 163, 184, 0.3)',
              background: '#0b1220',
              color: '#e2e8f0',
              fontSize: 16,
            }}
          />
          <button
            onClick={load}
            disabled={!merchantId || loading}
            style={{
              padding: '0.85rem 1.4rem',
              borderRadius: 999,
              border: 'none',
              background: 'linear-gradient(120deg, #22c55e, #16a34a)',
              color: '#04110a',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
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
          { label: 'Today', data: summary?.revenue?.today },
          { label: 'Last 7 days', data: summary?.revenue?.sevenDays },
          { label: 'Last 30 days', data: summary?.revenue?.thirtyDays },
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
        {topProducts.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No data yet.</p>
        ) : (
          topProducts.map((p, idx) => (
            <div key={p.productId} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: idx < topProducts.length - 1 ? '1px solid rgba(148,163,184,0.1)' : 'none' }}>
              <span>{p.productName}</span>
              <span>₦{Number(p.revenue).toLocaleString()}</span>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
