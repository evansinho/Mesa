import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from '@tanstack/react-router'
import { BackBar } from '../components/ui/BackBar'
import { StatusBadge } from '../components/ui/StatusBadge'
import { naira } from '../components/ui/HeroCard'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

type OrderRow = {
  id: string
  status: string
  total: string
  createdAt: string
  customerName: string | null
}

type CustomerProfile = {
  phone: string
  name: string | null
  orderCount: number
  totalSpend: number
  orders: OrderRow[]
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^\d/.test(parts[0])) return parts[0].slice(-2)
  return parts.map(p => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function relDate(iso: string) {
  const d = new Date(iso)
  const diffH = Math.floor((Date.now() - d.getTime()) / 3_600_000)
  if (diffH < 24) return diffH < 1 ? 'Just now' : `${diffH}h ago`
  if (diffH < 48) return 'Yesterday'
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

export default function CustomerProfilePage() {
  const { phone } = useParams({ from: '/_auth/customers/$phone' })
  const navigate = useNavigate()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data, isLoading, error } = useQuery<{ customer: CustomerProfile }>({
    queryKey: ['customer-profile', merchantId, phone],
    enabled: !!merchantId && !!phone,
    queryFn: async () => {
      const res = await apiFetch(
        `/analytics/customers/${encodeURIComponent(phone)}?merchantId=${encodeURIComponent(merchantId)}`
      )
      if (!res.ok) throw new Error('Failed to load customer')
      return res.json()
    },
  })

  const customer = data?.customer
  const displayName = customer?.name ?? phone
  const av = initials(displayName)

  return (
    <div className="pb-tab">
      <BackBar onBack={() => navigate({ to: '/customers' })} title={customer?.name ?? 'Customer'} />
      <div className="pad">
        {isLoading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--subtle)' }}>Loading…</div>}
        {error && <div style={{ color: 'var(--danger)', fontSize: 13, padding: '8px 0' }}>Failed to load customer</div>}

        {customer && (
          <>
            {/* Header card */}
            <div className="card card-lg card-pad fade-up">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div className="o-av" style={{ width: 52, height: 52, fontSize: 20, borderRadius: 14 }}>
                  {av}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-.02em' }}>{displayName}</div>
                  {customer.name && (
                    <div className="mono muted" style={{ fontSize: 12, marginTop: 2 }}>{phone}</div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 24, marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                <div>
                  <div className="kicker">Total spend</div>
                  <div className="naira" style={{ fontSize: 26, marginTop: 5 }}>{naira(customer.totalSpend)}</div>
                </div>
                <div style={{ width: 1, background: 'var(--line)' }} />
                <div>
                  <div className="kicker">Orders</div>
                  <div style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 26, marginTop: 5 }}>
                    {customer.orderCount}
                  </div>
                </div>
              </div>
            </div>

            {/* WhatsApp action */}
            <a
              href={`https://wa.me/${phone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="wa-msg-btn"
              style={{ marginTop: 12 }}
            >
              💬 Message on WhatsApp
            </a>

            {/* Order history */}
            {customer.orders.length > 0 && (
              <>
                <div className="sec-head"><span className="st">Order history</span></div>
                <div className="card fade-up">
                  {customer.orders.map((o, i) => (
                    <div
                      key={o.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '13px 16px',
                        borderBottom: i < customer.orders.length - 1 ? '1px solid var(--line)' : 'none',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--fm)', fontSize: 12, color: 'var(--subtle)' }}>
                          #{o.id.slice(-5).toUpperCase()}
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>
                          {relDate(o.createdAt)}
                        </div>
                      </div>
                      <StatusBadge status={o.status} />
                      <div className="naira" style={{ fontSize: 15, flexShrink: 0 }}>
                        {naira(Number(o.total))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
