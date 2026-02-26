'use client'

import { useEffect, useMemo, useState } from 'react'

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

export default function OrdersPage() {
  const [merchantId, setMerchantId] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canFetch = merchantId.trim().length > 0

  useEffect(() => {
    if (!canFetch) return
    const run = async () => {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/orders?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) {
        const text = await res.text()
        setError(text || 'Failed to load orders')
        setLoading(false)
        return
      }
      const data = await res.json() as { orders?: Order[] }
      setOrders(data.orders ?? [])
      setLoading(false)
    }
    void run()
  }, [merchantId, canFetch])

  const rows = useMemo(() => orders.map(order => ({
    ...order,
    createdAtLabel: new Date(order.createdAt).toLocaleString(),
  })), [orders])

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
          Orders
        </p>
        <h1 style={{ fontSize: 36, margin: '0.5rem 0 1rem' }}>Merchant Orders</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={merchantId}
            onChange={e => setMerchantId(e.target.value)}
            placeholder="Enter merchant ID to load orders"
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
          {loading && <span style={{ color: '#94a3b8' }}>Loading…</span>}
          {error && <span style={{ color: '#fca5a5' }}>{error}</span>}
        </div>
      </header>

      <section style={{
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 18,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.5fr 1fr 1fr 1fr',
          gap: '1rem',
          padding: '1rem 1.5rem',
          fontSize: 13,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: '#94a3b8',
          borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        }}>
          <div>Customer</div>
          <div>Status</div>
          <div>Total</div>
          <div>Created</div>
        </div>

        {rows.length === 0 && !loading && (
          <div style={{ padding: '1.5rem', color: '#94a3b8' }}>
            No orders yet.
          </div>
        )}

        {rows.map(order => (
          <div
            key={order.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 1fr 1fr 1fr',
              gap: '1rem',
              padding: '1rem 1.5rem',
              borderBottom: '1px solid rgba(148, 163, 184, 0.06)',
              alignItems: 'center',
              cursor: 'pointer',
            }}
            onClick={() => setSelected(order)}
          >
            <div style={{ display: 'grid' }}>
              <span style={{ fontWeight: 600 }}>{order.customerName ?? order.customerPhone}</span>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>{order.customerPhone}</span>
            </div>
            <div style={{ textTransform: 'capitalize' }}>{order.status.toLowerCase()}</div>
            <div>₦{Number(order.total).toLocaleString()}</div>
            <div style={{ color: '#94a3b8', fontSize: 13 }}>{order.createdAtLabel}</div>
          </div>
        ))}
      </section>

      {selected && (
        <div
          onClick={() => setSelected(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 10, 20, 0.6)',
            display: 'flex',
            justifyContent: 'flex-end',
            zIndex: 40,
          }}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              background: '#0b1220',
              borderLeft: '1px solid rgba(148, 163, 184, 0.2)',
              padding: '1.5rem',
              display: 'grid',
              gap: '1.25rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 20, margin: 0 }}>Order {selected.id.slice(0, 8)}</h2>
              <button
                onClick={() => setSelected(null)}
                style={{
                  background: 'transparent',
                  color: '#94a3b8',
                  border: 'none',
                  fontSize: 20,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>

            <div>
              <p style={{ color: '#94a3b8', margin: 0 }}>Customer</p>
              <p style={{ margin: '0.25rem 0 0' }}>{selected.customerName ?? selected.customerPhone}</p>
              <p style={{ color: '#94a3b8', margin: 0, fontSize: 13 }}>{selected.customerPhone}</p>
            </div>

            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Status</span>
                <span style={{ textTransform: 'capitalize' }}>{selected.status.toLowerCase()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Total</span>
                <span>₦{Number(selected.total).toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Created</span>
                <span>{new Date(selected.createdAt).toLocaleString()}</span>
              </div>
            </div>

            <div>
              <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Items</p>
              {selected.items.map(item => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6 }}>
                  <span>{item.productName} × {item.quantity}</span>
                  <span>₦{Number(item.agreedPrice ?? item.unitPrice).toLocaleString()}</span>
                </div>
              ))}
            </div>

            <div>
              <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Payment</p>
              {selected.payments?.length ? (
                <div style={{ fontSize: 14 }}>
                  <div>Status: {selected.payments[0].status.toLowerCase()}</div>
                  {selected.payments[0].amount && (
                    <div>Amount: ₦{Number(selected.payments[0].amount).toLocaleString()}</div>
                  )}
                </div>
              ) : (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>No payment yet.</div>
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  )
}
