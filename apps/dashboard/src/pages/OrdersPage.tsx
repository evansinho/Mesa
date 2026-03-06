import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type OrderItem = {
  id: string
  productName: string
  quantity: number
  unitPrice: string
  agreedPrice: string
}

type Order = {
  id: string
  customerPhone: string
  customerName?: string | null
  status: string
  total: string
  createdAt: string
  items: OrderItem[]
  payments?: Array<{ id: string; status: string; amount?: string | null; createdAt: string }>
}

const STATUS_OPTIONS = ['ALL', 'PENDING', 'CONFIRMED', 'AWAITING_PAYMENT', 'PAID', 'FULFILLED', 'CANCELLED']

function statusBadgeClass(status: string) {
  switch (status) {
    case 'PAID': case 'FULFILLED': return 'badge badge-green'
    case 'CONFIRMED': case 'AWAITING_PAYMENT': return 'badge badge-yellow'
    case 'CANCELLED': return 'badge badge-red'
    default: return 'badge badge-gray'
  }
}

export default function OrdersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [selected, setSelected] = useState<Order | null>(null)
  const [statusFilter, setStatusFilter] = useState('ALL')

  const { data, isLoading, error } = useQuery<Order[]>({
    queryKey: ['orders', merchantId, statusFilter],
    enabled: !!merchantId,
    queryFn: async () => {
      const params = new URLSearchParams({ merchantId })
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      const res = await apiFetch(`/orders?${params.toString()}`)
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json() as { orders?: Order[] }
      return json.orders ?? []
    },
  })

  const rows = useMemo(() => (data ?? []).map(order => ({
    ...order,
    createdAtLabel: new Date(order.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }),
  })), [data])

  return (
    <>
      <div className="page-header">
        <span className="section-label">Orders</span>
        <h1>Orders</h1>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <select
          className="form-input"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ width: 'auto', minWidth: 160 }}
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s === 'ALL' ? 'All statuses' : s.replace('_', ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}</option>
          ))}
        </select>
        {isLoading && <span style={{ color: 'var(--smoke)', fontSize: '0.875rem' }}>Loading…</span>}
        {error && <span style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{(error as Error).message}</span>}
      </div>

      {/* Mobile: card list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} className="mobile-list">
        {rows.length === 0 && !isLoading && (
          <div className="card" style={{ padding: '1.5rem', color: 'var(--smoke)', textAlign: 'center' }}>No orders yet.</div>
        )}
        {rows.map(order => (
          <div key={order.id} className="list-card" onClick={() => setSelected(order)}>
            <div className="flex-between" style={{ marginBottom: '0.5rem' }}>
              <div>
                <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9375rem' }}>
                  {order.customerName ?? order.customerPhone}
                </p>
                {order.customerName && (
                  <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>{order.customerPhone}</p>
                )}
              </div>
              <span className={statusBadgeClass(order.status)}>
                {order.status.replace(/_/g, ' ').toLowerCase()}
              </span>
            </div>
            <div className="flex-between">
              <span style={{ fontWeight: 700, color: 'var(--forest)', fontSize: '1rem' }}>
                ₦{Number(order.total).toLocaleString()}
              </span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>{order.createdAtLabel}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Detail panel / bottom sheet */}
      {selected && (
        <div className="detail-overlay" onClick={() => setSelected(null)}>
          <div className="detail-panel" onClick={e => e.stopPropagation()}>
            <div className="flex-between" style={{ marginBottom: '1.25rem' }}>
              <h2 style={{ fontFamily: 'var(--font-head)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--ink)' }}>
                Order #{selected.id.slice(0, 8)}
              </h2>
              <button
                onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--smoke)', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}
              >
                ×
              </button>
            </div>

            <div style={{ display: 'grid', gap: '1rem' }}>
              {/* Customer */}
              <div>
                <p style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--smoke)', marginBottom: 4 }}>Customer</p>
                <p style={{ fontWeight: 600, color: 'var(--ink)' }}>{selected.customerName ?? selected.customerPhone}</p>
                {selected.customerName && <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>{selected.customerPhone}</p>}
              </div>

              <hr className="divider" />

              {/* Details */}
              <div style={{ display: 'grid', gap: '0.5rem', fontSize: '0.9rem' }}>
                <div className="flex-between">
                  <span style={{ color: 'var(--smoke)' }}>Status</span>
                  <span className={statusBadgeClass(selected.status)}>{selected.status.replace(/_/g, ' ').toLowerCase()}</span>
                </div>
                <div className="flex-between">
                  <span style={{ color: 'var(--smoke)' }}>Total</span>
                  <span style={{ fontWeight: 700, color: 'var(--forest)' }}>₦{Number(selected.total).toLocaleString()}</span>
                </div>
                <div className="flex-between">
                  <span style={{ color: 'var(--smoke)' }}>Created</span>
                  <span>{new Date(selected.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
              </div>

              <hr className="divider" />

              {/* Items */}
              <div>
                <p style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--smoke)', marginBottom: 8 }}>Items</p>
                <div style={{ display: 'grid', gap: '0.4rem' }}>
                  {selected.items.map(item => (
                    <div key={item.id} className="flex-between" style={{ fontSize: '0.875rem' }}>
                      <span style={{ color: 'var(--ink)' }}>{item.productName} × {item.quantity}</span>
                      <span style={{ fontWeight: 600 }}>₦{Number(item.agreedPrice ?? item.unitPrice).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>

              <hr className="divider" />

              {/* Payment */}
              <div>
                <p style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--smoke)', marginBottom: 8 }}>Payment</p>
                {selected.payments?.length ? (
                  <div style={{ fontSize: '0.875rem', display: 'grid', gap: '0.4rem' }}>
                    <div className="flex-between">
                      <span style={{ color: 'var(--smoke)' }}>Status</span>
                      <span className={statusBadgeClass(selected.payments[0].status)}>{selected.payments[0].status.toLowerCase()}</span>
                    </div>
                    {selected.payments[0].amount && (
                      <div className="flex-between">
                        <span style={{ color: 'var(--smoke)' }}>Amount</span>
                        <span style={{ fontWeight: 600 }}>₦{Number(selected.payments[0].amount).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.875rem', color: 'var(--smoke)' }}>No payment yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
