import { useQuery } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type Customer = {
  customerPhone: string
  customerName: string | null
  orderCount: number
  totalSpend: number
  lastOrderAt: string
}

type CustomersData = {
  topCustomers: Customer[]
  atRisk: Customer[]
  stats: {
    totalCustomers: number
    repeatCustomers: number
    repeatRate: number
    atRiskCount: number
  }
}

function daysAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function displayName(c: Customer) {
  return c.customerName ?? c.customerPhone
}

export default function CustomersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data, isLoading, error } = useQuery<CustomersData>({
    queryKey: ['analytics-customers', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/customers?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<CustomersData>
    },
  })

  const stats = data?.stats
  const top = data?.topCustomers ?? []
  const atRisk = data?.atRisk ?? []

  return (
    <>
      <div className="page-header">
        <span className="section-label">Customers</span>
        <h1>Customer Intelligence</h1>
        {isLoading && <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>}
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: 6 }}>{(error as Error).message}</p>}
      </div>

      {/* Stat strip */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {[
            { label: 'Total customers', value: stats.totalCustomers.toString() },
            { label: 'Repeat rate', value: `${stats.repeatRate}%`, sub: `${stats.repeatCustomers} of ${stats.totalCustomers} ordered again` },
            { label: 'At risk', value: stats.atRiskCount.toString(), sub: 'No order in 14+ days', danger: stats.atRiskCount > 0 },
          ].map(stat => (
            <div key={stat.label} className="card" style={{ padding: '1rem 1.1rem' }}>
              <p style={{ fontSize: '0.75rem', color: 'var(--smoke)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                {stat.label}
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700, color: stat.danger ? 'var(--danger)' : 'var(--ink)', fontFamily: 'var(--font-head)' }}>
                {stat.value}
              </p>
              {stat.sub && (
                <p style={{ fontSize: '0.75rem', color: 'var(--smoke)', marginTop: 2 }}>{stat.sub}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* At-risk customers */}
      {atRisk.length > 0 && (
        <div className="table-container" style={{ marginBottom: '1.25rem' }}>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ghost)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)' }} />
            <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}>
              Follow up — haven't ordered in 14+ days
            </h2>
          </div>
          {atRisk.map((c, idx) => (
            <div
              key={c.customerPhone}
              className="flex-between"
              style={{
                padding: '0.875rem 1.25rem',
                borderBottom: idx < atRisk.length - 1 ? '1px solid rgba(184,201,193,0.3)' : 'none',
                fontSize: '0.9rem',
              }}
            >
              <div>
                <p style={{ fontWeight: 600, color: 'var(--ink)' }}>{displayName(c)}</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--smoke)' }}>
                  {c.orderCount} order{c.orderCount !== 1 ? 's' : ''} · last {daysAgo(c.lastOrderAt)}
                </p>
              </div>
              <span style={{ fontWeight: 600, color: 'var(--forest)' }}>₦{c.totalSpend.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Top customers */}
      <div className="table-container">
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--ghost)' }}>
          <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}>
            Top customers by spend
          </h2>
        </div>
        {top.length === 0 && !isLoading ? (
          <div style={{ padding: '1.5rem', color: 'var(--smoke)', fontSize: '0.875rem' }}>No customers yet.</div>
        ) : (
          top.map((c, idx) => (
            <div
              key={c.customerPhone}
              className="flex-between"
              style={{
                padding: '0.875rem 1.25rem',
                borderBottom: idx < top.length - 1 ? '1px solid rgba(184,201,193,0.3)' : 'none',
                fontSize: '0.9rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--ghost)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700, color: 'var(--forest)', flexShrink: 0,
                }}>
                  {idx + 1}
                </span>
                <div>
                  <p style={{ fontWeight: 600, color: 'var(--ink)' }}>{displayName(c)}</p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--smoke)' }}>
                    {c.orderCount} order{c.orderCount !== 1 ? 's' : ''} · last {daysAgo(c.lastOrderAt)}
                    {c.orderCount > 1 && <span style={{ marginLeft: 6, color: 'var(--forest)', fontWeight: 600 }}>repeat</span>}
                  </p>
                </div>
              </div>
              <span style={{ fontWeight: 700, color: 'var(--forest)', fontSize: '1rem' }}>
                ₦{c.totalSpend.toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  )
}
