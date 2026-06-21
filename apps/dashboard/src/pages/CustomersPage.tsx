import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { TopBar } from '../components/ui/TopBar'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

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

function initials(c: Customer) {
  const n = c.customerName ?? c.customerPhone
  const parts = n.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^\d/.test(parts[0])) return parts[0].slice(-2)
  return parts.map(p => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function displayName(c: Customer) {
  return c.customerName ?? c.customerPhone
}

function daysAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

export default function CustomersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const navigate = useNavigate()

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

  const goToProfile = (phone: string) =>
    navigate({ to: '/customers/$phone', params: { phone } })

  return (
    <div className="pb-tab stagger">
      <TopBar title="Customers" sub="Who keeps you in business" />
      <div className="pad">
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {error && <div style={{ color: 'var(--danger)', fontSize: 13, padding: '8px 0' }}>{(error as Error).message}</div>}

        {/* Stat cards — 2 col */}
        {stats && (
          <div className="grid2 fade-up" style={{ marginBottom: 24 }}>
            <div className="card card-pad">
              <div className="kicker">Total</div>
              <div className="naira" style={{ fontSize: 38, marginTop: 10, letterSpacing: '-.04em' }}>{stats.totalCustomers}</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>customers</div>
            </div>
            <div className="card card-pad">
              <div className="kicker">Repeat</div>
              <div style={{ fontSize: 38, fontFamily: 'var(--fd)', fontWeight: 800, marginTop: 10, letterSpacing: '-.04em', color: 'var(--mint-deep)' }}>
                {stats.repeatRate}%
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>ordered again</div>
            </div>
          </div>
        )}

        {/* At-risk section */}
        {atRisk.length > 0 && (
          <>
            <div className="sec-head">
              <span className="st">Follow up</span>
              <span style={{ fontSize: 12.5, color: 'var(--danger)', fontFamily: 'var(--fm)' }}>
                {atRisk.length} quiet 14+ days
              </span>
            </div>
            <div className="card card-pad fade-up" style={{ marginBottom: 8 }}>
              {atRisk.map((c, i) => (
                <div
                  key={c.customerPhone}
                  style={{
                    paddingBottom: i < atRisk.length - 1 ? 14 : 0,
                    marginBottom: i < atRisk.length - 1 ? 14 : 0,
                    borderBottom: i < atRisk.length - 1 ? '1px solid var(--line)' : 'none',
                    cursor: 'pointer',
                  }}
                  onClick={() => goToProfile(c.customerPhone)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                    <div className="o-av">
                      {initials(c)}
                    </div>
                    <div className="r-main">
                      <div className="r-t">{displayName(c)}</div>
                      <div className="r-s">{c.orderCount} order{c.orderCount !== 1 ? 's' : ''} · last {daysAgo(c.lastOrderAt)}</div>
                    </div>
                    <div style={{ fontFamily: 'var(--fd)', fontWeight: 700, fontSize: 15, color: 'var(--forest)', flexShrink: 0 }}>
                      ₦{c.totalSpend.toLocaleString()}
                    </div>
                  </div>
                  <a
                    href={`https://wa.me/${c.customerPhone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wa-msg-btn"
                    onClick={e => e.stopPropagation()}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                    </svg>
                    Message on WhatsApp
                  </a>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Top customers */}
        <div className="sec-head"><span className="st">Top customers by spend</span></div>
        {top.length === 0 && !isLoading ? (
          <div className="card card-pad tcenter fade-up" style={{ padding: 40, color: 'var(--muted)' }}>
            No customers yet.
          </div>
        ) : (
          <div className="card card-pad fade-up">
            {top.map(c => (
              <div
                key={c.customerPhone}
                className="row"
                role="button"
                onClick={() => goToProfile(c.customerPhone)}
                style={{ cursor: 'pointer' }}
              >
                <div className="o-av">{initials(c)}</div>
                <div className="r-main">
                  <div className="r-t">
                    {displayName(c)}
                    {c.orderCount > 1 && (
                      <span style={{ marginLeft: 7, fontSize: 11, fontFamily: 'var(--fm)', background: 'var(--mint-soft)', color: 'var(--mint-deep)', padding: '2px 7px', borderRadius: 99, verticalAlign: 'middle' }}>
                        repeat
                      </span>
                    )}
                  </div>
                  <div className="r-s">{c.orderCount} order{c.orderCount !== 1 ? 's' : ''} · last {daysAgo(c.lastOrderAt)}</div>
                </div>
                <div style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 16, color: 'var(--forest)', flexShrink: 0 }}>
                  ₦{c.totalSpend.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
