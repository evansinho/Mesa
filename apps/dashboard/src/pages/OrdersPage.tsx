import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { OrderCard, type Order } from '../components/ui/OrderCard'
import { useOverlay } from '../context/OverlayContext'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

const FILTERS = [
  { id: 'all',             label: 'All',              status: '' },
  { id: 'pending',         label: 'Pending',          status: 'PENDING' },
  { id: 'confirmed',       label: 'Confirmed',        status: 'CONFIRMED' },
  { id: 'awaiting',        label: 'Awaiting payment', status: 'AWAITING_PAYMENT' },
  { id: 'paid',            label: 'Paid',             status: 'PAID' },
  { id: 'fulfilled',       label: 'Fulfilled',        status: 'FULFILLED' },
  { id: 'cancelled',       label: 'Cancelled',        status: 'CANCELLED' },
]

export default function OrdersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const qc = useQueryClient()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()
  const [filter, setFilter] = useState('all')

  const { data, isLoading } = useQuery<{ orders: Order[] }>({
    queryKey: ['orders-all', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/orders?merchantId=${encodeURIComponent(merchantId)}&limit=100`)
      if (!res.ok) return { orders: [] }
      return res.json()
    },
  })

  const allOrders = data?.orders ?? []

  const counts: Record<string, number> = {
    all: allOrders.length,
    pending: allOrders.filter(o => o.status === 'PENDING').length,
    confirmed: allOrders.filter(o => o.status === 'CONFIRMED').length,
    awaiting: allOrders.filter(o => o.status === 'AWAITING_PAYMENT').length,
    paid: allOrders.filter(o => o.status === 'PAID').length,
    fulfilled: allOrders.filter(o => o.status === 'FULFILLED').length,
    cancelled: allOrders.filter(o => o.status === 'CANCELLED').length,
  }

  const activeFilter = FILTERS.find(f => f.id === filter)!
  const displayOrders = activeFilter.status
    ? allOrders.filter(o => o.status === activeFilter.status)
    : allOrders

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/orders/${id}/confirm`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders-all', merchantId] })
      qc.invalidateQueries({ queryKey: ['orders-confirm', merchantId] })
      qc.invalidateQueries({ queryKey: ['analytics-summary', merchantId] })
      toast('Order confirmed · customer notified')
    },
  })

  return (
    <div className="pb-tab">
      <TopBar title="Orders" sub="Caught from your chats" />
      <div className="pills pills-wrap">
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={`pill${filter === f.id ? ' on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}{counts[f.id] > 0 ? ` · ${counts[f.id]}` : ''}
          </button>
        ))}
      </div>
      <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {!isLoading && displayOrders.length === 0 && (
          <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>Nothing here yet.</div>
        )}
        {displayOrders.map(o => (
          <OrderCard
            key={o.id}
            order={o}
            onConfirm={id => confirmMutation.mutate(id)}
            onOpen={id => openOverlay({ type: 'order-detail', orderId: id })}
          />
        ))}
      </div>
    </div>
  )
}
