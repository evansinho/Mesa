import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { OrderCard, type Order } from '../components/ui/OrderCard'
import { useOverlay } from '../context/OverlayContext'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

const FILTERS = [
  { id: 'pending',   label: 'To confirm', status: 'PENDING' },
  { id: 'confirmed', label: 'Confirmed',  status: 'CONFIRMED,AWAITING_PAYMENT,PAID,FULFILLED' },
  { id: 'all',       label: 'All',        status: '' },
]

import { useState } from 'react'

export default function OrdersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const qc = useQueryClient()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()
  const [filter, setFilter] = useState('pending')

  const fetchOrders = async (status: string) => {
    const params = new URLSearchParams({ merchantId })
    if (status) params.set('status', status)
    const res = await apiFetch(`/orders?${params}`)
    if (!res.ok) return { orders: [] }
    return res.json() as Promise<{ orders: Order[] }>
  }

  const pending  = useQuery({ queryKey: ['orders', merchantId, 'pending'],   enabled: !!merchantId, queryFn: () => fetchOrders('PENDING') })
  const confirmed = useQuery({ queryKey: ['orders', merchantId, 'confirmed'], enabled: !!merchantId, queryFn: () => fetchOrders('CONFIRMED,AWAITING_PAYMENT,PAID,FULFILLED') })
  const all      = useQuery({ queryKey: ['orders', merchantId, 'all'],       enabled: !!merchantId, queryFn: () => fetchOrders('') })

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/orders/${id}/confirm`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders', merchantId] })
      qc.invalidateQueries({ queryKey: ['orders-confirm', merchantId] })
      qc.invalidateQueries({ queryKey: ['analytics-summary', merchantId] })
      toast('Order confirmed · customer notified')
    },
  })

  const counts = {
    pending:   pending.data?.orders.length ?? 0,
    confirmed: confirmed.data?.orders.length ?? 0,
    all:       all.data?.orders.length ?? 0,
  }

  const displayOrders =
    filter === 'pending'   ? pending.data?.orders ?? [] :
    filter === 'confirmed' ? confirmed.data?.orders ?? [] :
    all.data?.orders ?? []

  const isLoading = filter === 'pending' ? pending.isLoading : filter === 'confirmed' ? confirmed.isLoading : all.isLoading

  return (
    <div className="pb-tab">
      <TopBar title="Orders" sub="Caught from your chats" />
      <div className="pills">
        {FILTERS.map(f => (
          <button key={f.id} className={`pill${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label} · {counts[f.id as keyof typeof counts]}
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
