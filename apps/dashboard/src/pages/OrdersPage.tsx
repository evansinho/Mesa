import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
import { OrderCard, type Order } from '../components/ui/OrderCard'
import { StatusBadge } from '../components/ui/StatusBadge'
import { naira } from '../components/ui/HeroCard'
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

function dateGroupLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This week'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Older']

function initials(o: Order) {
  const n = o.customerName ?? o.customerPhone
  return n.split(' ').filter(Boolean).map((p: string) => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function relDate(iso: string) {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const diffH = Math.floor(diffMs / 3600_000)
  if (diffH < 24) return diffH < 1 ? 'Just now' : `${diffH}h ago`
  if (diffH < 48) return 'Yesterday'
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

function itemSummary(items: Order['items']) {
  if (items.length === 0) return '—'
  const first = `${items[0].quantity}× ${items[0].productName}`
  if (items.length === 1) return first
  return `${first} +${items.length - 1} more`
}

export default function OrdersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const qc = useQueryClient()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

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
  const q = search.toLowerCase().trim()

  const displayOrders = useMemo(() => {
    let list = activeFilter.status
      ? allOrders.filter(o => o.status === activeFilter.status)
      : allOrders
    if (q) {
      list = list.filter(o =>
        (o.customerName ?? '').toLowerCase().includes(q) ||
        o.customerPhone.includes(q) ||
        o.items.some(i => i.productName.toLowerCase().includes(q))
      )
    }
    return list
  }, [allOrders, activeFilter.status, q])

  const grouped = useMemo(() => {
    const map: Record<string, Order[]> = {}
    for (const o of displayOrders) {
      const label = dateGroupLabel(o.createdAt)
      if (!map[label]) map[label] = []
      map[label].push(o)
    }
    return GROUP_ORDER.filter(g => map[g]).map(g => ({ label: g, orders: map[g] }))
  }, [displayOrders])

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
      <div className="pad" style={{ paddingTop: 4 }}>
        <div className="orders-search">
          <Search size={16} strokeWidth={2} />
          <input
            type="text"
            placeholder="Search by name or product…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>
      {/* Mobile: grouped cards */}
      <div className="orders-cards pad" style={{ display: 'flex', flexDirection: 'column', paddingTop: 4 }}>
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {!isLoading && displayOrders.length === 0 && (
          <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
            {q ? `No results for "${search}"` : 'Nothing here yet.'}
          </div>
        )}
        {grouped.map(({ label, orders }) => (
          <div key={label}>
            <div className="date-group-label">{label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 4 }}>
              {orders.map(o => (
                <OrderCard
                  key={o.id}
                  order={o}
                  onConfirm={id => confirmMutation.mutate(id)}
                  onOpen={id => openOverlay({ type: 'order-detail', orderId: id })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: table view */}
      <div className="orders-table pad" style={{ paddingTop: 4 }}>
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {!isLoading && displayOrders.length === 0 && (
          <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
            {q ? `No results for "${search}"` : 'Nothing here yet.'}
          </div>
        )}
        {!isLoading && displayOrders.length > 0 && (
          <div className="ot-wrap">
            <div className="ot-head">
              <div>Customer</div>
              <div>Items</div>
              <div>Total</div>
              <div>Status</div>
              <div>Date</div>
            </div>
            <div>
              {displayOrders.map(o => (
                <div
                  key={o.id}
                  className="ot-row"
                  onClick={() => openOverlay({ type: 'order-detail', orderId: o.id })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && openOverlay({ type: 'order-detail', orderId: o.id })}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="ot-av">{initials(o)}</div>
                    <div className="ot-name">{o.customerName ?? o.customerPhone}</div>
                  </div>
                  <div className="ot-cell" style={{ color: 'var(--muted)' }}>{itemSummary(o.items)}</div>
                  <div className="ot-total">{naira(parseFloat(o.total))}</div>
                  <div className="ot-cell"><StatusBadge status={o.status} /></div>
                  <div className="ot-cell" style={{ color: 'var(--muted)', fontFamily: 'var(--fm)', fontSize: 12.5 }}>{relDate(o.createdAt)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
